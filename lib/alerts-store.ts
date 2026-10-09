import { createHash } from "node:crypto";
import { env } from "./runtime";
import { allRows, requireWarehouse } from "./inventory-store";
import { serverConfig } from "./server-config";
import { turnoverAlertMessages, turnoverAlertRows, sendRobotMessage } from "./dingtalk";
import { turnoverCards, cardTemplateId } from "./dingtalk-card-data";
import { sendInventoryReport } from "./dingtalk-cards";
import { normalizeQuantity, compareQuantity } from "./decimal";
import { shanghaiTimestamp } from "./jackyun";
import { normalizeTurnoverThreshold, normalizeTurnoverDays, normalizeExcludedNames, excludedByName } from "./turnover-alert";
import { groupState, robotScope, validateGroupSelection, type DingTalkGroupState } from "./dingtalk-groups-store";
import { sqlite } from "./sqlite.mjs";
import { attachReportExport, reportExportBaseUrl } from "./alert-report-export";

export type AlertSettings = {
  warehouseCode: string; enabled: boolean; threshold: string; turnoverAverageThreshold: string;
  turnoverDays: string; excludedNameKeywords: string[]; notifyTime: string; revision: number;
  warehouseSchedule?: { code: string; dailyTime: string }; lastSentAt: string | null; lastResult: string | null;
  robotConfigured: boolean; cardConfigured: boolean; exportAvailable: boolean; groupState: DingTalkGroupState;
};
type SettingsRecord = { enabled:number; threshold:string; turnover_average_threshold:string; turnover_days:string; excluded_name_keywords:string; notify_time:string; revision:number; last_sent_at:string|null; last_result:string|null };
export function validateDailyTime(value: unknown): string {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("请选择有效的每日时间（HH:mm）");
  return value;
}
export function alertRuleHash(rule: Pick<AlertSettings,"turnoverAverageThreshold"|"turnoverDays"|"excludedNameKeywords">) {
  return createHash("sha256").update(JSON.stringify([rule.turnoverAverageThreshold,rule.turnoverDays,rule.excludedNameKeywords])).digest("hex");
}
export function legacyAverageThreshold(rule: Pick<AlertSettings,"turnoverAverageThreshold"|"turnoverDays"|"excludedNameKeywords">) {
  return rule.turnoverDays === "30" && !rule.excludedNameKeywords.length ? rule.turnoverAverageThreshold : null;
}
export async function settings(owner: string, code = "CK031"): Promise<AlertSettings> {
  const warehouse = await requireWarehouse(owner,code), db = sqlite();
  db.prepare("INSERT OR IGNORE INTO warehouse_alert_settings (owner,warehouse_code) VALUES (?,?)").run(owner,warehouse.code);
  const record = db.prepare("SELECT * FROM warehouse_alert_settings WHERE owner=? AND warehouse_code=?").get(owner,warehouse.code) as SettingsRecord;
  return { warehouseCode:warehouse.code, enabled:!!record.enabled, threshold:record.threshold,
    turnoverAverageThreshold:record.turnover_average_threshold, turnoverDays:record.turnover_days,
    excludedNameKeywords:JSON.parse(record.excluded_name_keywords), notifyTime:record.notify_time, revision:record.revision,
    warehouseSchedule:{code:warehouse.code,dailyTime:warehouse.dailyTime},lastSentAt:record.last_sent_at,lastResult:record.last_result,
    robotConfigured:serverConfig().robotConfigured,cardConfigured:!!cardTemplateId(),exportAvailable:!!reportExportBaseUrl(),groupState:groupState(owner,warehouse.code) };
}
export async function saveCollectionSchedule(owner:string,code:unknown,time:unknown) {
  const warehouse=await requireWarehouse(owner,typeof code==="string"?code:""),dailyTime=validateDailyTime(time);
  sqlite().prepare("UPDATE warehouses SET daily_time=? WHERE owner=? AND code=?").run(dailyTime,owner,warehouse.code);
  return {code:warehouse.code,dailyTime};
}
export async function saveSettings(owner: string, enabled: boolean, threshold: unknown, turnoverAverageThreshold?: unknown, selectedGroupIds?: unknown, notifyTime?: unknown,
  warehouseOptions?: { warehouseCode: unknown; dailyTime?: unknown; turnoverDays?: unknown; excludedNameKeywords?: unknown }) {
  const current=await settings(owner,typeof warehouseOptions?.warehouseCode==="string"?warehouseOptions.warehouseCode:"CK031");
  const code=current.warehouseCode,quantity=normalizeQuantity(threshold);
  if (compareQuantity(quantity,"0")<0 || compareQuantity(quantity,"1000000")>0) throw new Error("预警阈值须为0至1000000的数量");
  if (enabled && !serverConfig().robotConfigured) throw new Error("先配置钉钉机器人应用凭证，再开启预警");
  const average=turnoverAverageThreshold===undefined?current.turnoverAverageThreshold:normalizeTurnoverThreshold(turnoverAverageThreshold);
  const days=warehouseOptions?.turnoverDays===undefined?current.turnoverDays:normalizeTurnoverDays(warehouseOptions.turnoverDays);
  const keywords=warehouseOptions?.excludedNameKeywords===undefined?current.excludedNameKeywords:normalizeExcludedNames(warehouseOptions.excludedNameKeywords);
  const time=notifyTime===undefined?current.notifyTime:validateDailyTime(notifyTime);
  const collectionTime=warehouseOptions?.dailyTime===undefined?undefined:validateDailyTime(warehouseOptions.dailyTime);
  const db=sqlite(),scope=robotScope(owner);
  db.exec("BEGIN IMMEDIATE");
  try {
    const ids=selectedGroupIds===undefined?groupState(owner,code).groups.filter(g=>g.enabled).map(g=>g.id):validateGroupSelection(owner,selectedGroupIds);
    if(enabled && !ids.length) throw new Error("请先刷新群列表并勾选至少一个接收预警的群");
    db.prepare("DELETE FROM warehouse_alert_groups WHERE owner=? AND client_id=? AND robot_code=? AND warehouse_code=?").run(...scope,code);
    for(const id of ids)db.prepare("INSERT INTO warehouse_alert_groups (owner,client_id,robot_code,warehouse_code,open_conversation_id) VALUES(?,?,?,?,?)").run(...scope,code,id);
    db.prepare(`UPDATE warehouse_alert_settings SET enabled=?,threshold=?,turnover_average_threshold=?,turnover_days=?,excluded_name_keywords=?,notify_time=?,revision=revision+1 WHERE owner=? AND warehouse_code=?`)
      .run(enabled?1:0,quantity,average,days,JSON.stringify(keywords),time,owner,code);
    if(collectionTime!==undefined)db.prepare("UPDATE warehouses SET daily_time=? WHERE owner=? AND code=?").run(collectionTime,owner,code);
    db.exec("COMMIT");
  } catch(error){db.exec("ROLLBACK");throw error;}
  return settings(owner,code);
}
export async function previewTurnoverAlert(owner: string, code: string, threshold?: unknown, turnoverDays?: unknown, excludedNameKeywords?: unknown) {
  const saved=await settings(owner,code);
  const average=threshold===undefined?saved.turnoverAverageThreshold:normalizeTurnoverThreshold(threshold);
  const days=turnoverDays===undefined?saved.turnoverDays:normalizeTurnoverDays(turnoverDays);
  const keywords=excludedNameKeywords===undefined?saved.excludedNameKeywords:normalizeExcludedNames(excludedNameKeywords);
  const {view,rows}=await allRows(owner,code,7,true);
  const eligible=turnoverAlertRows(rows,average,days);
  // Exclusions affect only the outgoing report, never the inventory table's metrics/highlighting.
  const matching=eligible.filter(row=>!excludedByName(row.goodsName,keywords));
  const messages=matching.length?turnoverAlertMessages(matching,average,view.warehouseName+"（"+code+"）",view.snapshot!.capturedAt,days):[];
  const cards=turnoverCards(matching,average,view.warehouseName+"（"+code+"）",view.snapshot!.capturedAt,days);
  return {snapshotId:view.snapshot!.id,capturedAt:view.snapshot!.capturedAt,date:shanghaiTimestamp(new Date(view.snapshot!.capturedAt)).slice(0,10),
    count:matching.length,eligibleCount:eligible.length,excludedCount:eligible.length-matching.length,
    averageThreshold:average,turnoverDays:days,excludedNameKeywords:keywords,ruleHash:alertRuleHash({turnoverAverageThreshold:average,turnoverDays:days,excludedNameKeywords:keywords}),
    warehouseCode:code,incomplete:!!view.unavailableSkus?.length,cards,cardConfigured:saved.cardConfigured,exportAvailable:saved.exportAvailable,
    messages,message:messages.length?messages.join("\n\n"):eligible.length?"符合预警的商品均已按名称排除，无需发送。":"当前没有符合周转预警条件的货品。"};
}
export async function notifyAfterSnapshot(owner: string, snapshotId: string, code: string, sender = sendRobotMessage) {
  const current=await settings(owner,code);
  if(!current.enabled || !current.robotConfigured)return;
  const preview=await previewTurnoverAlert(owner,code);
  if(preview.snapshotId!==snapshotId || preview.incomplete || preview.ruleHash!==alertRuleHash(current))return;
  const db=sqlite(),scope=robotScope(owner);
  if(!preview.count){db.prepare("UPDATE warehouse_alert_settings SET last_result=? WHERE owner=? AND warehouse_code=? AND revision=?").run(preview.message,owner,code,current.revision);return;}
  let acceptedCount=0,uncertainCount=0,deferred=false;
  for(const group of current.groupState.groups.filter(g=>g.enabled)) {
    const claimed=db.prepare(`INSERT OR IGNORE INTO turnover_group_deliveries
      (owner,client_id,robot_code,open_conversation_id,warehouse_code,date,snapshot_id,average_threshold,matching_count,state,attempted_at,rule_hash)
      SELECT ?,?,?,?,?,?,?,?,?,'sending',?,? WHERE EXISTS
        (SELECT 1 FROM warehouse_alert_settings WHERE owner=? AND warehouse_code=? AND enabled=1 AND revision=?)
        AND EXISTS (SELECT 1 FROM warehouse_alert_groups s JOIN dingtalk_groups g
          ON g.owner=s.owner AND g.client_id=s.client_id AND g.robot_code=s.robot_code AND g.open_conversation_id=s.open_conversation_id
          WHERE s.owner=? AND s.client_id=? AND s.robot_code=? AND s.warehouse_code=? AND s.open_conversation_id=? AND g.active=1)
        AND NOT EXISTS (SELECT 1 FROM turnover_alert_deliveries WHERE owner=? AND warehouse_code=? AND date=?)
        AND NOT EXISTS (SELECT 1 FROM stock_snapshots WHERE owner=? AND warehouse_code=? AND status='complete' AND coverage='auto:v1' AND captured_at>?)
        AND NOT EXISTS (SELECT 1 FROM manual_alert_deliveries m,json_each(m.result,'$.groups') g
          WHERE m.owner=? AND m.client_id=? AND m.robot_code=? AND m.warehouse_code=? AND m.snapshot_id=? AND (m.rule_hash=? OR (m.rule_hash='' AND m.average_threshold=?))
          AND json_extract(g.value,'$.id')=? AND json_extract(g.value,'$.state') IN ('pending','unconfirmed','accepted'))`)
      .run(...scope,group.id,code,preview.date,snapshotId,current.turnoverAverageThreshold,preview.count,new Date().toISOString(),preview.ruleHash,
        owner,code,current.revision,...scope,code,group.id,owner,code,preview.date,owner,code,preview.capturedAt,...scope,code,snapshotId,preview.ruleHash,legacyAverageThreshold(current),group.id);
    if(!claimed.changes){
      if(db.prepare(`SELECT 1 FROM manual_alert_deliveries m,json_each(m.result,'$.groups') g WHERE m.owner=? AND m.client_id=? AND m.robot_code=?
        AND m.warehouse_code=? AND m.snapshot_id=? AND (m.rule_hash=? OR (m.rule_hash='' AND m.average_threshold=?)) AND m.state='sending'
        AND json_extract(g.value,'$.id')=? AND json_extract(g.value,'$.state') IN ('pending','unconfirmed','accepted')`)
        .get(...scope,code,snapshotId,preview.ruleHash,legacyAverageThreshold(current),group.id))deferred=true;
      continue;
    }
    db.prepare("UPDATE warehouse_alert_settings SET last_result=? WHERE owner=? AND warehouse_code=?").run(code+"：周转预警发送中",owner,code);
    try {
      const report=sender===sendRobotMessage?attachReportExport(owner,code,preview):preview;
      await sendInventoryReport({clientId:scope[1],clientSecret:env.DINGTALK_CLIENT_SECRET!,robotCode:scope[2],openConversationId:group.id},report,sender);
      const accepted=new Date().toISOString();
      db.prepare("UPDATE turnover_group_deliveries SET state='accepted',accepted_at=? WHERE owner=? AND client_id=? AND robot_code=? AND open_conversation_id=? AND warehouse_code=? AND date=?").run(accepted,...scope,group.id,code,preview.date);
      db.prepare("UPDATE warehouse_alert_settings SET last_sent_at=? WHERE owner=? AND warehouse_code=?").run(accepted,owner,code);acceptedCount++;
    } catch {
      db.prepare("UPDATE turnover_group_deliveries SET state='unconfirmed' WHERE owner=? AND client_id=? AND robot_code=? AND open_conversation_id=? AND warehouse_code=? AND date=?").run(...scope,group.id,code,preview.date);uncertainCount++;
    }
  }
  if(acceptedCount || uncertainCount)db.prepare("UPDATE warehouse_alert_settings SET last_result=? WHERE owner=? AND warehouse_code=?")
    .run(`${code}：${preview.count} 款预警，钉钉已受理 ${acceptedCount} 个群${uncertainCount?`，${uncertainCount} 个群发送未确认，请核对群消息；今天不自动重发`:"；每群每天一次，以群内消息为准"}`,owner,code);
  return {deferred};
}
