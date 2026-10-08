import { createHash } from "node:crypto";
import { env } from "./runtime";
import { sqlite } from "./sqlite.mjs";
import { previewTurnoverAlert, settings } from "./alerts-store";
import { robotScope } from "./dingtalk-groups-store";
import { sendRobotMessage } from "./dingtalk";
import { DingTalkCardError, sendInventoryReport } from "./dingtalk-cards";
import { normalizeTurnoverThreshold } from "./turnover-alert";

export type ManualAlertRequest = {
  requestId: string; warehouseCode: string; snapshotId: string;
  averageThreshold: string; groupIds: string[];
};
export type ManualAlertResult = {
  state: "sending" | "complete"; count: number;
  groups: { id: string; name: string; acceptedParts: number; totalParts: number; state: "pending" | "accepted" | "unconfirmed" | "failed" | "skipped"; error?: string }[];
  message: string;
};
export class ManualAlertError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const COOLDOWN_MS = 30_000;

function validateRequest(value: unknown): ManualAlertRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManualAlertError("发送参数无效");
  const body = value as Record<string, unknown>;
  if (typeof body.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)) throw new ManualAlertError("发送请求编号无效");
  if (typeof body.warehouseCode !== "string" || !body.warehouseCode || body.warehouseCode.length > 50 || typeof body.snapshotId !== "string" || !body.snapshotId || body.snapshotId.length > 100) throw new ManualAlertError("请选择已采集的仓库");
  if (!Array.isArray(body.groupIds) || !body.groupIds.length || body.groupIds.length > 1000 || body.groupIds.some(id => typeof id !== "string" || !id || id.length > 512)) throw new ManualAlertError("请勾选接收预警的群");
  return { requestId: body.requestId, warehouseCode: body.warehouseCode, snapshotId: body.snapshotId,
    averageThreshold: normalizeTurnoverThreshold(body.averageThreshold), groupIds: [...new Set(body.groupIds as string[])].sort() };
}

// A persisted request owns its send attempts, even if the HTTP connection is lost.
// Replaying it returns progress/results and never retries an uncertain group.
export async function sendManualAlert(owner: string, input: unknown, sender = sendRobotMessage): Promise<ManualAlertResult> {
  const request = validateRequest(input), db = sqlite(), scope = robotScope(owner);
  const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const lookup = () => db.prepare("SELECT payload_hash,result,attempted_at FROM manual_alert_deliveries WHERE owner=? AND client_id=? AND robot_code=? AND request_id=?").get(...scope, request.requestId) as { payload_hash: string; result: string; attempted_at: number } | undefined;
  const replay = (record: NonNullable<ReturnType<typeof lookup>>) => {
    if (record.payload_hash !== hash) throw new ManualAlertError("该发送请求的内容已改变，请重新预览", 409);
    const result = JSON.parse(record.result) as ManualAlertResult;
    const deadline = 60_000 + result.groups.reduce((total,g)=>total+g.totalParts*31_000,0);
    if (result.state === "sending" && Date.now()-record.attempted_at > deadline) {
      result.state = "complete";
      result.groups.forEach(group=>{ if(group.state === "pending")group.state="skipped"; });
      result.message = "发送任务已中断，已受理的部分保留；未确认的部分请先核对群消息，本请求不会重新发送。";
      db.prepare("UPDATE manual_alert_deliveries SET state='complete',result=? WHERE owner=? AND client_id=? AND robot_code=? AND request_id=?").run(JSON.stringify(result),...scope,request.requestId);
    }
    return result;
  };
  const existing = lookup();
  if (existing) return replay(existing);
  const current = await settings(owner);
  if (!current.robotConfigured) throw new ManualAlertError("请先配置钉钉机器人应用凭证");
  const groups = current.groupState.groups.filter(group => group.enabled);
  if (current.turnoverAverageThreshold !== request.averageThreshold || JSON.stringify(groups.map(g => g.id).sort()) !== JSON.stringify(request.groupIds)) throw new ManualAlertError("预警规则或接收群已变化，请重新预览并保存", 409);
  const preview = await previewTurnoverAlert(owner, request.warehouseCode, request.averageThreshold);
  if (preview.snapshotId !== request.snapshotId) throw new ManualAlertError("仓库数据已更新，请重新预览后发送", 409);
  if (preview.incomplete) throw new ManualAlertError("本次库存采集不完整，暂不能发送预警");
  if (!preview.count) throw new ManualAlertError("当前仓库没有符合预警条件的货品，无需发送");
  const result: ManualAlertResult = { state: "sending", count: preview.count,
    groups: groups.map(g => ({ id: g.id, name: g.name || g.id, acceptedParts: 0, totalParts: preview.cardConfigured && sender === sendRobotMessage ? preview.cards.length : preview.messages.length, state: "pending" })), message: "正在发送，请稍候；请勿重复发送。" };
  const now = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const concurrent = lookup();
    if (concurrent) { db.exec("COMMIT"); return replay(concurrent); }
    const recent = db.prepare("SELECT state,attempted_at,result FROM manual_alert_deliveries WHERE owner=? AND client_id=? AND robot_code=? ORDER BY attempted_at DESC LIMIT 1").get(...scope) as { state: string; attempted_at: number; result: string } | undefined;
    const maxRunTime = recent ? 60_000 + (JSON.parse(recent.result) as ManualAlertResult).groups.reduce((total,g)=>total+g.totalParts*31_000,0) : 0;
    if (recent && (now - recent.attempted_at < COOLDOWN_MS || (recent.state === "sending" && now - recent.attempted_at < maxRunTime))) {
      // An unfinished run requires checking its result instead of starting another send.
      throw new ManualAlertError(recent.state === "sending" ? "已有通知正在发送，请等待结果" : "距离上次发送尝试不足30秒，请稍后再试", 429);
    }
    db.prepare("INSERT INTO manual_alert_deliveries VALUES(?,?,?,?,?,?,'sending',?,?)").run(...scope, request.requestId, hash, request.warehouseCode, JSON.stringify(result), now);
    db.exec("COMMIT");
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  const persist = () => db.prepare("UPDATE manual_alert_deliveries SET state=?,result=? WHERE owner=? AND client_id=? AND robot_code=? AND request_id=?").run(result.state, JSON.stringify(result), ...scope, request.requestId);
  const secret = env.DINGTALK_CLIENT_SECRET!;
  for (const group of result.groups) {
    const selected = db.prepare("SELECT 1 FROM dingtalk_groups WHERE owner=? AND client_id=? AND robot_code=? AND open_conversation_id=? AND active=1 AND enabled=1").get(...scope, group.id);
    if (!selected || robotScope(owner).some((value, i) => value !== scope[i])) { group.state = "skipped"; persist(); continue; }
    // Persist uncertainty before the external call: a crash cannot cause a retry.
    group.state = "unconfirmed"; persist();
    try {
      await sendInventoryReport({ clientId: scope[1], clientSecret: secret, robotCode: scope[2], openConversationId: group.id }, preview, sender, parts=>{group.acceptedParts=parts;persist();});
      group.state = "accepted";
      db.prepare("UPDATE alert_settings SET last_sent_at=? WHERE owner=?").run(new Date().toISOString(), owner);
    } catch (error) {
      if (error instanceof DingTalkCardError && error.rejected) group.state = "failed";
      // Only expose our sanitized errors, never upstream bodies or credentials.
      if (error instanceof Error && error.message.startsWith("钉钉")) group.error = error.message;
      else group.error = "钉钉发送未确认：未取得有效受理回执，请先核对群消息；本次不会自动重发";
    }
    persist();
  }
  result.state = "complete";
  const accepted = result.groups.filter(g => g.state === "accepted").length;
  const uncertain = result.groups.filter(g => g.state === "unconfirmed").length;
  const failed = result.groups.filter(g => g.state === "failed").length;
  const skipped = result.groups.filter(g => g.state === "skipped").length;
  result.message = `${request.warehouseCode}：${preview.count} 款预警，钉钉已受理 ${accepted} 个群${failed ? `，${failed} 个群发送失败，请查看下方错误` : ""}${uncertain ? `，${uncertain} 个群未确认，请先核对群消息` : accepted ? "，请到群内查看" : ""}${skipped ? `；${skipped} 个群因勾选或成员关系变化已跳过` : ""}。`;
  persist();
  db.prepare("UPDATE alert_settings SET last_result=? WHERE owner=?").run("手动发送 · " + result.message, owner);
  return result;
}
