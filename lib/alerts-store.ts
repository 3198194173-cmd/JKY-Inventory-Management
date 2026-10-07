import { env } from "./runtime";
import { allRows, database, requireWarehouse } from "./inventory-store";
import { serverConfig } from "./server-config";
import { turnoverAlertMessages, turnoverAlertRows, sendRobotMessage } from "./dingtalk";
import { turnoverCards, cardTemplateId } from "./dingtalk-card-data";
import { sendInventoryReport } from "./dingtalk-cards";
import { normalizeQuantity, compareQuantity } from "./decimal";
import { shanghaiTimestamp } from "./jackyun";
import { DEFAULT_TURNOVER_AVERAGE_THRESHOLD, normalizeTurnoverThreshold } from "./turnover-alert";
import { groupState, robotScope, validateGroupSelection, type DingTalkGroupState } from "./dingtalk-groups-store";
import { sqlite } from "./sqlite.mjs";

export type AlertSettings = { enabled: boolean; threshold: string; turnoverAverageThreshold: string; notifyTime: string; warehouseSchedule?: { code: string; dailyTime: string }; lastSentAt: string | null; lastResult: string | null; robotConfigured: boolean; cardConfigured: boolean; groupState: DingTalkGroupState };
type SettingsRecord = { enabled: number; threshold: string; turnover_average_threshold: string; notify_time: string; last_digest: string | null; last_sent_at: string | null; last_result: string | null };
export function validateDailyTime(value: unknown): string {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("请选择有效的每日时间（HH:mm）");
  return value;
}

export async function settings(owner: string): Promise<AlertSettings> {
  const record = await database().prepare("SELECT * FROM alert_settings WHERE owner = ?").bind(owner).first<SettingsRecord>();
  return { enabled: !!record?.enabled, threshold: record?.threshold || "0", turnoverAverageThreshold: record?.turnover_average_threshold ?? DEFAULT_TURNOVER_AVERAGE_THRESHOLD, notifyTime: record?.notify_time || "08:30", lastSentAt: record?.last_sent_at || null, lastResult: record?.last_result || null, robotConfigured: serverConfig().robotConfigured, cardConfigured: !!cardTemplateId(), groupState: groupState(owner) };
}

export async function saveSettings(owner: string, enabled: boolean, threshold: unknown, turnoverAverageThreshold?: unknown, selectedGroupIds?: unknown, notifyTime?: unknown, collection?: { warehouseCode: unknown; dailyTime: unknown }) {
  const quantity = normalizeQuantity(threshold);
  if (compareQuantity(quantity, "0") < 0 || compareQuantity(quantity, "1000000") > 0) throw new Error("预警阈值须为 0 至 1000000 的数量");
  if (enabled && !serverConfig().robotConfigured) throw new Error("先配置钉钉机器人应用凭证，再开启预警");
  const turnoverThreshold = turnoverAverageThreshold === undefined ? null : normalizeTurnoverThreshold(turnoverAverageThreshold);
  const notificationTime = notifyTime === undefined ? null : validateDailyTime(notifyTime);
  const warehouseSchedule = collection ? { code: (await requireWarehouse(owner, typeof collection.warehouseCode === "string" ? collection.warehouseCode : "")).code, dailyTime: validateDailyTime(collection.dailyTime) } : undefined;
  const db = sqlite();
  db.exec("BEGIN IMMEDIATE");
  try {
    const ids = selectedGroupIds === undefined ? groupState(owner).groups.filter(g => g.enabled).map(g => g.id) : validateGroupSelection(owner, selectedGroupIds);
    if (enabled && !ids.length) throw new Error("请先刷新群列表并勾选至少一个接收预警的群");
    if (selectedGroupIds !== undefined) db.prepare(`UPDATE dingtalk_groups SET enabled=CASE WHEN active=1 AND open_conversation_id IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END
      WHERE owner=? AND client_id=? AND robot_code=?`).run(JSON.stringify(ids), ...robotScope(owner));
    db.prepare("INSERT INTO alert_settings (owner, enabled, threshold, turnover_average_threshold) VALUES (?, ?, ?, COALESCE(?, '3')) ON CONFLICT(owner) DO UPDATE SET enabled = excluded.enabled, threshold = excluded.threshold, turnover_average_threshold = COALESCE(?, alert_settings.turnover_average_threshold)").run(owner, enabled ? 1 : 0, quantity, turnoverThreshold, turnoverThreshold);
    if (notificationTime !== null) db.prepare("UPDATE alert_settings SET notify_time=? WHERE owner=?").run(notificationTime, owner);
    if (warehouseSchedule) db.prepare("UPDATE warehouses SET daily_time=? WHERE owner=? AND code=?").run(warehouseSchedule.dailyTime, owner, warehouseSchedule.code);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { ...await settings(owner), ...(warehouseSchedule ? { warehouseSchedule } : {}) };
}

export async function previewTurnoverAlert(owner: string, code: string, threshold?: unknown) {
  const saved = await settings(owner);
  const average = threshold === undefined ? saved.turnoverAverageThreshold : normalizeTurnoverThreshold(threshold);
  const {view,rows} = await allRows(owner,code,7,true);
  const matching = turnoverAlertRows(rows,average);
  const messages = matching.length ? turnoverAlertMessages(matching,average,view.warehouseName+"（"+code+"）",view.snapshot!.capturedAt) : [];
  const cards = turnoverCards(matching,average,view.warehouseName+"（"+code+"）",view.snapshot!.capturedAt);
  return {snapshotId:view.snapshot!.id,capturedAt:view.snapshot!.capturedAt,date:shanghaiTimestamp(new Date(view.snapshot!.capturedAt)).slice(0,10),
    count:matching.length,averageThreshold:average,warehouseCode:code,incomplete:!!view.unavailableSkus?.length,
    cards, cardConfigured:saved.cardConfigured,
    messages, message:messages.length ? messages.join("\n\n") : "当前没有符合周转预警条件的货品。"};
}

export async function notifyAfterSnapshot(owner: string, snapshotId: string, code: string, sender = sendRobotMessage) {
  const current = await settings(owner);
  if (!current.enabled || !current.robotConfigured) return;
  const preview = await previewTurnoverAlert(owner,code,current.turnoverAverageThreshold);
  if (preview.snapshotId !== snapshotId || preview.incomplete) return;
  if (!preview.count) {
    await database().prepare("UPDATE alert_settings SET last_result='本次没有符合周转预警条件的货品' WHERE owner=? AND enabled=1 AND turnover_average_threshold=?").bind(owner,current.turnoverAverageThreshold).run();
    return;
  }
  const scope = robotScope(owner);
  const groups = current.groupState.groups.filter(g => g.enabled);
  let acceptedCount = 0, uncertainCount = 0;
  for (const group of groups) {
  // Each selected group has its own daily claim; one failed group does not block other groups.
  const claimed = await database().prepare(`INSERT OR IGNORE INTO turnover_group_deliveries
    (owner,client_id,robot_code,open_conversation_id,warehouse_code,date,snapshot_id,average_threshold,matching_count,state,attempted_at)
    SELECT ?,?,?,?,?,?,?,?,?,'sending',? WHERE EXISTS
      (SELECT 1 FROM alert_settings WHERE owner=? AND enabled=1 AND turnover_average_threshold=?)
      AND EXISTS (SELECT 1 FROM dingtalk_groups WHERE owner=? AND client_id=? AND robot_code=? AND open_conversation_id=? AND enabled=1 AND active=1)
      AND NOT EXISTS (SELECT 1 FROM turnover_alert_deliveries WHERE owner=? AND warehouse_code=? AND date=?)
      AND NOT EXISTS (SELECT 1 FROM stock_snapshots WHERE owner=? AND warehouse_code=? AND status='complete' AND coverage='auto:v1' AND captured_at>?)`)
    .bind(...scope,group.id,code,preview.date,snapshotId,current.turnoverAverageThreshold,preview.count,new Date().toISOString(),owner,current.turnoverAverageThreshold,...scope,group.id,owner,code,preview.date,owner,code,preview.capturedAt).run();
  if (!claimed.meta.changes) continue;
  await database().prepare("UPDATE alert_settings SET last_result=? WHERE owner=?").bind(code+"：周转预警发送中",owner).run();
  try {
    await sendInventoryReport({clientId:scope[1],clientSecret:env.DINGTALK_CLIENT_SECRET!,robotCode:scope[2],openConversationId:group.id},preview,sender);
    const accepted = new Date().toISOString();
    await database().batch([
      database().prepare("UPDATE turnover_group_deliveries SET state='accepted',accepted_at=? WHERE owner=? AND client_id=? AND robot_code=? AND open_conversation_id=? AND warehouse_code=? AND date=?").bind(accepted,...scope,group.id,code,preview.date),
      database().prepare("UPDATE alert_settings SET last_sent_at=? WHERE owner=?").bind(accepted,owner)
    ]);
    acceptedCount++;
  } catch {
    await database().batch([
      database().prepare("UPDATE turnover_group_deliveries SET state='unconfirmed' WHERE owner=? AND client_id=? AND robot_code=? AND open_conversation_id=? AND warehouse_code=? AND date=?").bind(...scope,group.id,code,preview.date)
    ]);
    uncertainCount++;
  }
  }
  if (acceptedCount || uncertainCount) await database().prepare("UPDATE alert_settings SET last_result=? WHERE owner=?").bind(`${code}：${preview.count} 款预警，钉钉已受理 ${acceptedCount} 个群${uncertainCount ? `，${uncertainCount} 个群发送未确认，请核对群消息；今天不自动重发` : "；每群每天一次，以群内消息为准"}`,owner).run();
}
