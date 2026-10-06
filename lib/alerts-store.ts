import { env } from "./runtime";
import { allRows, database } from "./inventory-store";
import { serverConfig } from "./server-config";
import { turnoverAlertMessage, turnoverAlertRows, sendRobotMessage } from "./dingtalk";
import { normalizeQuantity, compareQuantity } from "./decimal";
import { shanghaiTimestamp } from "./jackyun";
import { DEFAULT_TURNOVER_AVERAGE_THRESHOLD, normalizeTurnoverThreshold } from "./turnover-alert";

export type AlertSettings = { enabled: boolean; threshold: string; turnoverAverageThreshold: string; lastSentAt: string | null; lastResult: string | null; robotConfigured: boolean };
type SettingsRecord = { enabled: number; threshold: string; turnover_average_threshold: string; last_digest: string | null; last_sent_at: string | null; last_result: string | null };

export async function settings(owner: string): Promise<AlertSettings> {
  const record = await database().prepare("SELECT * FROM alert_settings WHERE owner = ?").bind(owner).first<SettingsRecord>();
  return { enabled: !!record?.enabled, threshold: record?.threshold || "0", turnoverAverageThreshold: record?.turnover_average_threshold ?? DEFAULT_TURNOVER_AVERAGE_THRESHOLD, lastSentAt: record?.last_sent_at || null, lastResult: record?.last_result || null, robotConfigured: serverConfig().robotConfigured };
}

export async function saveSettings(owner: string, enabled: boolean, threshold: unknown, turnoverAverageThreshold?: unknown) {
  const quantity = normalizeQuantity(threshold);
  if (compareQuantity(quantity, "0") < 0 || compareQuantity(quantity, "1000000") > 0) throw new Error("预警阈值须为 0 至 1000000 的数量");
  if (enabled && !serverConfig().robotConfigured) throw new Error("先配置钉钉机器人应用凭证与目标群，再开启预警");
  const turnoverThreshold = turnoverAverageThreshold === undefined ? null : normalizeTurnoverThreshold(turnoverAverageThreshold);
  await database().prepare("INSERT INTO alert_settings (owner, enabled, threshold, turnover_average_threshold) VALUES (?, ?, ?, COALESCE(?, '3')) ON CONFLICT(owner) DO UPDATE SET enabled = excluded.enabled, threshold = excluded.threshold, turnover_average_threshold = COALESCE(?, alert_settings.turnover_average_threshold)").bind(owner, enabled ? 1 : 0, quantity, turnoverThreshold, turnoverThreshold).run();
  return settings(owner);
}

export async function previewTurnoverAlert(owner: string, code: string, threshold?: unknown) {
  const saved = await settings(owner);
  const average = threshold === undefined ? saved.turnoverAverageThreshold : normalizeTurnoverThreshold(threshold);
  const {view,rows} = await allRows(owner,code,7,true);
  const matching = turnoverAlertRows(rows,average);
  return {snapshotId:view.snapshot!.id,capturedAt:view.snapshot!.capturedAt,date:shanghaiTimestamp(new Date(view.snapshot!.capturedAt)).slice(0,10),
    count:matching.length,averageThreshold:average,warehouseCode:code,incomplete:!!view.unavailableSkus?.length,
    message:matching.length ? turnoverAlertMessage(matching,average,view.warehouseName+"（"+code+"）",view.snapshot!.capturedAt) : "当前没有符合周转预警条件的货品。"};
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
  // Claim before sending; uncertain responses must not cause duplicate messages.
  const claimed = await database().prepare(`INSERT OR IGNORE INTO turnover_alert_deliveries
    (owner,warehouse_code,date,snapshot_id,average_threshold,matching_count,state,attempted_at)
    SELECT ?,?,?,?,?,?,'sending',? WHERE EXISTS
      (SELECT 1 FROM alert_settings WHERE owner=? AND enabled=1 AND turnover_average_threshold=?)
      AND NOT EXISTS (SELECT 1 FROM stock_snapshots WHERE owner=? AND warehouse_code=? AND status='complete' AND coverage='auto:v1' AND captured_at>?)`)
    .bind(owner,code,preview.date,snapshotId,current.turnoverAverageThreshold,preview.count,new Date().toISOString(),owner,current.turnoverAverageThreshold,owner,code,preview.capturedAt).run();
  if (!claimed.meta.changes) return;
  await database().prepare("UPDATE alert_settings SET last_result=? WHERE owner=?").bind(code+"：周转预警发送中",owner).run();
  try {
    await sender({clientId:env.DINGTALK_CLIENT_ID!,clientSecret:env.DINGTALK_CLIENT_SECRET!,robotCode:env.DINGTALK_ROBOT_CODE!,openConversationId:env.DINGTALK_OPEN_CONVERSATION_ID!},preview.message);
    const accepted = new Date().toISOString();
    await database().batch([
      database().prepare("UPDATE turnover_alert_deliveries SET state='accepted',accepted_at=? WHERE owner=? AND warehouse_code=? AND date=?").bind(accepted,owner,code,preview.date),
      database().prepare("UPDATE alert_settings SET last_sent_at=?,last_result=? WHERE owner=?").bind(accepted,code+"：钉钉已受理 "+preview.count+" 款周转预警（每日一次）；以群内消息为准",owner)
    ]);
  } catch {
    await database().batch([
      database().prepare("UPDATE turnover_alert_deliveries SET state='unconfirmed' WHERE owner=? AND warehouse_code=? AND date=?").bind(owner,code,preview.date),
      database().prepare("UPDATE alert_settings SET last_result=? WHERE owner=?").bind(code+"：发送未确认，请核对群消息和机器人配置；本仓库今天不自动重发",owner)
    ]);
  }
}
