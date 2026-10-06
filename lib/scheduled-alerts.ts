import { createHash } from "node:crypto";
import { sqlite } from "./sqlite.mjs";
import { shanghaiTimestamp } from "./jackyun";
import { notifyAfterSnapshot, settings } from "./alerts-store";
import { sendRobotMessage } from "./dingtalk";

export async function sendDueAlerts(local = shanghaiTimestamp(), sender = sendRobotMessage) {
  const db = sqlite(), date = local.slice(0,10);
  const targets = db.prepare(`SELECT w.owner,w.code FROM warehouses w JOIN alert_settings a ON a.owner=w.owner
    WHERE a.enabled=1 AND a.notify_time<=? AND NOT EXISTS
    (SELECT 1 FROM local_jobs j WHERE j.owner=w.owner AND j.warehouse_code=w.code AND j.state IN ('queued','running'))`).all(local.slice(11,16)) as {owner:string;code:string}[];
  for (const target of targets) {
    const snapshot = db.prepare("SELECT id,captured_at FROM stock_snapshots WHERE owner=? AND warehouse_code=? AND status='complete' AND coverage='auto:v1' ORDER BY captured_at DESC LIMIT 1").get(target.owner,target.code) as {id:string;captured_at:string} | undefined;
    // Never send yesterday's cached inventory as today's scheduled report.
    if (!snapshot || shanghaiTimestamp(new Date(snapshot.captured_at)).slice(0,10) !== date) continue;
    const current = await settings(target.owner), groups = current.groupState.groups.filter(g=>g.enabled).map(g=>g.id).sort();
    if (!current.robotConfigured || !groups.length) continue;
    const fingerprint = createHash("sha256").update(JSON.stringify([snapshot.id,current.turnoverAverageThreshold,process.env.DINGTALK_CLIENT_ID,process.env.DINGTALK_ROBOT_CODE,groups])).digest("hex");
    if (db.prepare("SELECT 1 FROM scheduled_alert_checks WHERE owner=? AND warehouse_code=? AND date=? AND fingerprint=?").get(target.owner,target.code,date,fingerprint)) continue;
    await notifyAfterSnapshot(target.owner,snapshot.id,target.code,sender);
    db.prepare("INSERT INTO scheduled_alert_checks VALUES(?,?,?,?) ON CONFLICT(owner,warehouse_code,date) DO UPDATE SET fingerprint=excluded.fingerprint").run(target.owner,target.code,date,fingerprint);
  }
}
