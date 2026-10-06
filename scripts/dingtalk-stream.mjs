#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STREAM_ENDPOINT = 'https://api.dingtalk.com/v1.0/gateway/connections/open';
export const ROBOT_TOPIC = '/v1.0/im/bot/messages/get';

class CaptureError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function readCredentials(values, mode = 'group') {
  const credentials = {
    clientId: values.DINGTALK_CLIENT_ID?.trim() ?? '',
    clientSecret: values.DINGTALK_CLIENT_SECRET?.trim() ?? '',
    robotCode: values.DINGTALK_ROBOT_CODE?.trim() ?? '',
  };
  if (!credentials.clientId || !credentials.clientSecret || (mode === 'group' && !credentials.robotCode)) {
    throw new CaptureError('请在 .env.production 填写 DINGTALK_CLIENT_ID、DINGTALK_CLIENT_SECRET；获取群 ID 还需要 DINGTALK_ROBOT_CODE。目标群 ID 可暂时留空。');
  }
  return credentials;
}

export function connectionUrl(connection) {
  if (!record(connection) || typeof connection.endpoint !== 'string'
      || typeof connection.ticket !== 'string' || !connection.ticket) {
    throw new CaptureError('钉钉未返回有效的 Stream 连接信息，请检查当前应用凭证和对应的 Stream 配置。');
  }
  let url;
  try { url = new URL(connection.endpoint); }
  catch { throw new CaptureError('钉钉返回的 Stream 连接地址格式异常。'); }
  if (url.protocol !== 'wss:' || url.username || url.password) {
    throw new CaptureError('钉钉返回的 Stream 连接地址不符合安全连接格式。');
  }
  url.searchParams.set('ticket', connection.ticket);
  return url.href;
}

// Only protocol acknowledgements are returned here; no chat-send endpoint is used.
export function inspectFrame(frame, { passphrase, robotCode, mode = 'group' }) {
  const result = { ack: null, group: null, disconnect: false };
  if (!record(frame) || !record(frame.headers)) return result;
  const { headers } = frame;
  if (typeof headers.messageId !== 'string' || !headers.messageId) return result;
  if (frame.type === 'SYSTEM') {
    if (headers.topic === 'ping' || headers.topic === 'disconnect') {
      result.ack = { code: 200, headers, message: 'OK', data: frame.data };
      result.disconnect = headers.topic === 'disconnect';
    }
    return result;
  }
  if (mode === 'verify-events' && frame.type === 'EVENT') {
    // This setup tool has no business-event handler. Ask for redelivery rather
    // than acknowledging unprocessed events as successfully consumed.
    result.ack = {
      code: 200,
      headers: { contentType: 'application/json', messageId: headers.messageId },
      message: 'OK',
      data: JSON.stringify({ status: 'LATER', message: 'Connection verification only; no event consumer configured.' }),
    };
    return result;
  }
  if (mode !== 'group') return result;
  if (frame.type !== 'CALLBACK' || headers.topic !== ROBOT_TOPIC) return result;
  result.ack = {
    code: 200,
    headers: { contentType: 'application/json', messageId: headers.messageId },
    message: 'OK',
    data: JSON.stringify({ response: 'OK' }),
  };
  let data;
  try { data = JSON.parse(frame.data); }
  catch { return result; }
  if (!record(data) || String(data.conversationType) !== '2'
      || data.robotCode !== robotCode || !record(data.text)
      || typeof data.text.content !== 'string' || data.text.content.trim() !== passphrase
      || typeof data.conversationId !== 'string' || !data.conversationId.trim()) return result;
  result.group = {
    conversationId: data.conversationId.trim(),
    title: typeof data.conversationTitle === 'string' ? data.conversationTitle : '',
  };
  return result;
}

export async function connectStream(credentials, {
  mode = 'group',
  fetcher = globalThis.fetch,
  WebSocketType = globalThis.WebSocket,
  passphrase = `群ID确认-${randomBytes(6).toString('hex')}`,
  timeoutMs = 5 * 60 * 1000,
  onReady = () => {},
  signal,
} = {}) {
  if (!['group', 'verify-events'].includes(mode)) throw new CaptureError('不支持的 Stream 模式。');
  if (signal?.aborted) throw new CaptureError('已取消 Stream 接入。', 130);
  let response;
  try {
    response = await fetcher(STREAM_ENDPOINT, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        ua: 'warehouse-stream-setup/1.0',
        subscriptions: mode === 'group' ? [{ type: 'CALLBACK', topic: ROBOT_TOPIC }] : [{ type: 'EVENT', topic: '*' }],
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch {
    if (signal?.aborted) throw new CaptureError('已取消 Stream 接入。', 130);
    throw new CaptureError('无法申请钉钉 Stream 连接，请检查网络及应用配置。');
  }
  if (!response.ok) throw new CaptureError(`Stream 连接申请失败（HTTP ${response.status}），请检查应用凭证和对应的 Stream 配置；机器人模式还需检查发布状态。`);
  let connection;
  try { connection = await response.json(); }
  catch { throw new CaptureError('钉钉 Stream 响应格式异常。'); }
  const url = connectionUrl(connection);

  return new Promise((resolveGroup, reject) => {
    let socket;
    let finishing = false;
    let settled = false;
    let group = null;
    let opened = false;
    let verificationElapsed = false;
    let failure = null;
    let closeTimer;
    let queue = Promise.resolve();
    const cleanup = () => {
      clearTimeout(waitTimer);
      clearTimeout(handshakeTimer);
      clearTimeout(closeTimer);
      signal?.removeEventListener('abort', cancel);
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (group || (verificationElapsed && opened && !failure)) resolveGroup(group);
      else reject(failure ?? new CaptureError('Stream 连接已关闭，请重新运行。'));
    };
    const finish = error => {
      if (finishing) return;
      finishing = true;
      failure = error;
      clearTimeout(waitTimer);
      clearTimeout(handshakeTimer);
      // All ACKs are JSON text. Let native WebSocket flush its text writes before
      // closing; a bounded fallback also handles a peer that never closes.
      closeTimer = setTimeout(settle, 2_000);
      void (async () => {
        const flushDeadline = Date.now() + 500;
        while (socket?.readyState === 1 && socket.bufferedAmount > 0
               && Date.now() < flushDeadline && !settled) {
          await new Promise(done => setTimeout(done, 10));
        }
        try { socket?.close(1000); } catch { settle(); }
        if (!socket || socket.readyState === 3) settle();
      })();
    };
    const cancel = () => finish(new CaptureError('已结束 Stream 连接。', 130));
    const waitTimer = setTimeout(() => {
      if (mode === 'verify-events' && opened) {
        verificationElapsed = true;
        finish();
      } else finish(new CaptureError(mode === 'group'
        ? '等待已超时。请确认机器人已加入目标企业内部群，然后重新运行并 @机器人 发送新口令。'
        : '等待已超时，未能建立事件 Stream 连接，请检查网络和应用配置。'));
    }, timeoutMs);
    const handshakeTimer = setTimeout(() => finish(new CaptureError('Stream WebSocket 连接超时，请检查网络后重试。')), 15_000);
    signal?.addEventListener('abort', cancel, { once: true });
    try { socket = new WebSocketType(url); }
    catch { finish(new CaptureError('无法建立 Stream WebSocket 连接，请检查网络。')); return; }
    socket.addEventListener('open', () => {
      opened = true;
      clearTimeout(handshakeTimer);
      if (!finishing) onReady(passphrase);
    }, { once: true });
    socket.addEventListener('error', () => finish(new CaptureError('Stream WebSocket 连接失败，请检查网络和应用配置。')));
    socket.addEventListener('close', settle, { once: true });
    socket.addEventListener('message', event => {
      queue = queue.then(async () => {
        if (finishing || settled) return;
        let frame;
        try {
          const raw = typeof event.data === 'string' ? event.data : await event.data.text();
          frame = JSON.parse(raw);
        } catch { return; }
        const plan = inspectFrame(frame, { passphrase, robotCode: credentials.robotCode, mode });
        if (plan.ack) socket.send(JSON.stringify(plan.ack));
        if (plan.group) { group = plan.group; finish(); }
        else if (plan.disconnect) finish(new CaptureError('钉钉已结束当前 Stream 连接，请重新运行。'));
      }).catch(() => finish(new CaptureError('无法处理 Stream 协议回执，请重新运行。')));
    });
    if (signal?.aborted) cancel();
  });
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('用法：node scripts/dingtalk-stream.mjs [--verify-events]\n读取进程环境变量。默认获取群 ID；--verify-events 建立事件连接供控制台验证。最多运行 5 分钟；Ctrl+C 结束。');
    return 0;
  }
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--verify-events')) {
    throw new CaptureError('只接受 --verify-events 或 --help，不接受凭证命令行参数。');
  }
  const mode = args[0] === '--verify-events' ? 'verify-events' : 'group';
  if (Number(process.versions.node.split('.')[0]) < 24 || typeof globalThis.WebSocket !== 'function') {
    throw new CaptureError('请使用 Node.js 24 或更新版本运行此工具。');
  }
  const credentials = readCredentials(process.env, mode);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const group = await connectStream(credentials, {
      mode,
      signal: controller.signal,
      onReady: passphrase => console.log(mode === 'verify-events'
        ? '事件 Stream 已建立 WebSocket 连接。保持本窗口运行，回到钉钉事件订阅页面点击“已完成接入，验证连接通道”，成功后保存。最终以控制台验证结果为准。最多保持 5 分钟；完成后 Ctrl+C 结束。'
        : `机器人 Stream 已连接。请在目标企业内部群 @机器人 发送下面这一行：\n${passphrase}\n等待群回调（最多 5 分钟）……`),
    });
    if (!group) {
      console.log('连接验证时段已结束。若控制台尚未验证，请重新运行；本工具不处理业务事件。');
      return 0;
    }
    // JSON escaping keeps terminal control characters in the group title inert.
    console.log(`已取得目标群 ID：\nconversationId=${JSON.stringify(group.conversationId)}\ntitle=${JSON.stringify(group.title)}\n请将 conversationId 填入 DINGTALK_OPEN_CONVERSATION_ID。`);
    return 0;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => process.exit(code)).catch(error => {
    console.error(error instanceof CaptureError ? error.message : 'Stream 接入失败，请检查应用配置后重试。');
    process.exit(error instanceof CaptureError ? error.exitCode : 1);
  });
}
