import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectStream, inspectFrame, readCredentials, connectionUrl, STREAM_ENDPOINT, ROBOT_TOPIC } from '../scripts/dingtalk-stream.mjs';

const credentials = { clientId: 'test-app', clientSecret: 'test-secret', robotCode: 'test-robot' };
const passphrase = '群ID确认-test';
const callback = (overrides = {}) => ({
  type: 'CALLBACK', headers: { topic: ROBOT_TOPIC, messageId: 'callback-1' },
  data: JSON.stringify({ conversationType: '2', robotCode: credentials.robotCode,
    conversationId: 'cid-test==', conversationTitle: '库存预警测试群', text: { content: passphrase }, ...overrides }),
});
const inspect = frame => inspectFrame(frame, { passphrase, robotCode: credentials.robotCode });

function transport(frames = [], { open = true, disconnect = false } = {}) {
  const calls = [];
  const sockets = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ endpoint: 'wss://stream.example/connect', ticket: 'private-ticket' }) };
  };
  class Socket extends EventTarget {
    readyState = 0;
    bufferedAmount = 0;
    sent = [];
    constructor(url) {
      super();
      sockets.push(this);
      this.url = url;
      queueMicrotask(() => {
        if (!open) return;
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
        for (const frame of frames) {
          const event = new Event('message');
          event.data = typeof frame === 'string' ? frame : JSON.stringify(frame);
          this.dispatchEvent(event);
        }
        if (disconnect) queueMicrotask(() => this.close());
      });
    }
    send(text) { assert.equal(typeof text, 'string'); this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  return { fetcher, WebSocketType: Socket, calls, socket: () => sockets[0] };
}

test('event verification needs app credentials, group discovery additionally needs robot code', () => {
  const values = { DINGTALK_CLIENT_ID: ' test-app ', DINGTALK_CLIENT_SECRET: ' test-secret ' };
  assert.equal(readCredentials(values, 'verify-events').clientId, 'test-app');
  assert.throws(() => readCredentials(values), /DINGTALK_ROBOT_CODE/);
  assert.throws(() => readCredentials({}, 'verify-events'), /DINGTALK_CLIENT_ID/);
});

test('connection URL rejects insecure or missing credentials and encodes a fresh ticket', () => {
  for (const response of [{}, { endpoint: 'https://example.com', ticket: 'x' },
    { endpoint: 'wss://user:password@example.com', ticket: 'x' }, { endpoint: 'invalid', ticket: 'x' }]) {
    assert.throws(() => connectionUrl(response));
  }
  const url = new URL(connectionUrl({ endpoint: 'wss://example.com/connect?foo=bar', ticket: 'a&b' }));
  assert.equal(url.searchParams.get('ticket'), 'a&b');
  assert.equal(url.searchParams.get('foo'), 'bar');
});

test('only the exact challenge from the configured group robot can select the target group', () => {
  for (const overrides of [{ conversationType: '1' }, { robotCode: 'other-robot' },
    { text: { content: 'unrelated message' } }, { conversationId: '' }]) {
    const plan = inspect(callback(overrides));
    assert.equal(plan.group, null);
    assert.equal(plan.ack.headers.messageId, 'callback-1');
  }
  assert.deepEqual(inspect(callback()).group, { conversationId: 'cid-test==', title: '库存预警测试群' });
  assert.equal(inspect({ ...callback(), data: 'not-json' }).group, null);
});

test('system ping echoes data and a disconnect instructs the tool to close', () => {
  for (const topic of ['ping', 'disconnect']) {
    const frame = { type: 'SYSTEM', headers: { topic, messageId: 'system-1' }, data: '{"opaque":"test"}' };
    const plan = inspect(frame);
    assert.equal(plan.ack.data, frame.data);
    assert.equal(plan.disconnect, topic === 'disconnect');
  }
});

test('event verification does not discard real business events or capture robot callbacks', () => {
  const plan = inspectFrame({ type: 'EVENT', headers: { messageId: 'event-1', topic: '*' }, data: '{}' }, { mode: 'verify-events' });
  assert.equal(JSON.parse(plan.ack.data).status, 'LATER');
  assert.equal(inspectFrame(callback(), { mode: 'verify-events' }).ack, null);
});

test('group discovery opens only a robot callback subscription, ACKs and closes without sending a chat message', async () => {
  const ping = { type: 'SYSTEM', headers: { topic: 'ping', messageId: 'ping-1' }, data: '{"opaque":"x"}' };
  const fake = transport(['bad-json', callback({ text: { content: 'wrong challenge' } }), ping, callback()]);
  let ready = '';
  const result = await connectStream(credentials, { ...fake, passphrase, timeoutMs: 500, onReady: value => { ready = value; } });
  assert.equal(result.conversationId, 'cid-test==');
  assert.equal(ready, passphrase);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, STREAM_ENDPOINT);
  const request = JSON.parse(fake.calls[0].options.body);
  assert.deepEqual(request.subscriptions, [{ type: 'CALLBACK', topic: ROBOT_TOPIC }]);
  assert.equal(request.clientSecret, credentials.clientSecret);
  assert.equal(fake.socket().sent.length, 3);
  assert.equal(fake.socket().sent[1].data, ping.data);
  assert.equal(fake.socket().readyState, 3);
});

test('event mode requires no group ID or robot code and closes after the bounded window', async () => {
  const fake = transport();
  const result = await connectStream({ clientId: 'app', clientSecret: 'secret' }, { ...fake, mode: 'verify-events', timeoutMs: 25 });
  assert.equal(result, null);
  assert.deepEqual(JSON.parse(fake.calls[0].options.body).subscriptions, [{ type: 'EVENT', topic: '*' }]);
  assert.equal(fake.socket().readyState, 3);
});

test('group timeout and premature verification disconnect fail instead of reporting a verified connection', async () => {
  const group = transport();
  await assert.rejects(connectStream(credentials, { ...group, timeoutMs: 25 }), /超时/);
  assert.equal(group.socket().readyState, 3);
  const event = transport([], { disconnect: true });
  await assert.rejects(connectStream(credentials, { ...event, mode: 'verify-events', timeoutMs: 100 }), /已关闭/);
});

test('Ctrl+C cancellation closes an active connection and pre-cancellation never requests a ticket', async () => {
  const controller = new AbortController();
  const fake = transport();
  await assert.rejects(connectStream(credentials, { ...fake, signal: controller.signal,
    onReady: () => controller.abort() }), error => error.exitCode === 130);
  assert.equal(fake.socket().readyState, 3);
  const before = transport();
  await assert.rejects(connectStream(credentials, { ...before, signal: controller.signal }), /取消/);
  assert.equal(before.calls.length, 0);
});

test('network and HTTP failures are sanitized and never expose credentials or tickets', async () => {
  await assert.rejects(connectStream(credentials, { fetcher: async () => { throw new Error('private-secret private-ticket'); } }),
    error => /网络/.test(error.message) && !/private/.test(error.message));
  await assert.rejects(connectStream(credentials, { fetcher: async () => ({ ok: false, status: 401 }) }), /HTTP 401/);
});

test('a failed WebSocket constructor and unopened connection both release setup resources', async () => {
  const fake = transport();
  class BrokenSocket { constructor() { throw new Error('private-ticket'); } }
  await assert.rejects(connectStream(credentials, { ...fake, WebSocketType: BrokenSocket }),
    error => /建立/.test(error.message) && !/private-ticket/.test(error.message));
  const unopened = transport([], { open: false });
  await assert.rejects(connectStream(credentials, { ...unopened, mode: 'verify-events', timeoutMs: 25 }), /未能建立/);
  assert.equal(unopened.socket().readyState, 3);
});
