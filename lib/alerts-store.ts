import { env } from "./runtime";
import { database } from "./inventory-store";
import { serverConfig } from "./server-config";
import { alertDigest, alertMessage, alertRows, sendRobotMessage } from "./dingtalk";
import { normalizeQuantity, compareQuantity } from "./decimal";
import type { StockRow } from "./inventory-types";
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

export async function notifyAfterSnapshot(owner: string, rows: StockRow[], capturedAt: string, scopeLabel: string, scopeKey: string) {
  const current = await settings(owner);
  if (!current.enabled) return;
  const matching = alertRows(rows, current.threshold), digest = scopeKey + ":" + alertDigest(matching, current.threshold);
  const record = await database().prepare("SELECT last_digest FROM alert_settings WHERE owner = ?").bind(owner).first<{ last_digest: string | null }>();
  if (record?.last_digest === digest) return;
  if (!matching.length) {
    await database().prepare("UPDATE alert_settings SET last_digest = ?, last_result = '本次没有达到阈值的货品' WHERE owner = ? AND enabled = 1 AND threshold = ? AND last_digest IS ? AND NOT EXISTS (SELECT 1 FROM stock_snapshots WHERE owner = ? AND status = 'complete' AND captured_at > ?)").bind(digest, owner, current.threshold, record?.last_digest ?? null, owner, capturedAt).run();
    return;
  }
  // Record the attempt first; uncertain network outcomes never cause automatic duplicate sends.
  const claimed = await database().prepare("UPDATE alert_settings SET last_digest = ?, last_result = '消息发送中' WHERE owner = ? AND enabled = 1 AND threshold = ? AND (last_digest IS NULL OR last_digest <> ?) AND NOT EXISTS (SELECT 1 FROM stock_snapshots WHERE owner = ? AND status = 'complete' AND captured_at > ?)").bind(digest,owner,current.threshold,digest,owner,capturedAt).run();
  if(!claimed.meta.changes) return;
  try {
    await sendRobotMessage({ clientId: env.DINGTALK_CLIENT_ID!, clientSecret: env.DINGTALK_CLIENT_SECRET!, robotCode: env.DINGTALK_ROBOT_CODE!, openConversationId: env.DINGTALK_OPEN_CONVERSATION_ID! }, `采集范围：${scopeLabel}\n` + alertMessage(matching, current.threshold, capturedAt));
    await database().prepare("UPDATE alert_settings SET last_sent_at = ?, last_result = '钉钉已受理；以群内消息为准' WHERE owner = ? AND last_digest = ?").bind(new Date().toISOString(), owner, digest).run();
  } catch {
    await database().prepare("UPDATE alert_settings SET last_result = '发送未确认，请检查群内消息及机器人配置；相同内容不会自动重发' WHERE owner = ? AND last_digest = ?").bind(owner, digest).run();
  }
}
