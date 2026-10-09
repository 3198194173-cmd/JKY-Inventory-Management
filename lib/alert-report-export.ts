import { createHash, randomBytes } from "node:crypto";
import { sqlite } from "./sqlite.mjs";
import type { TurnoverCard } from "./dingtalk-card-data";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export function reportExportBaseUrl(): string | null {
  try {
    const url = new URL(process.env.INVENTORY_SITE_URL || "");
    if (!["http:","https:"].includes(url.protocol) || url.username || url.password ||
      ["localhost","127.0.0.1","[::1]","0.0.0.0"].includes(url.hostname.toLowerCase()) || url.hostname.endsWith(".localhost")) return null;
    return url.origin;
  } catch { return null; }
}
export function attachReportExport<T extends {cards:TurnoverCard[]}>(owner:string,code:string,report:T):T {
  const base=reportExportBaseUrl();
  if(!base)return report;
  const db=sqlite(),now=Date.now();
  db.prepare("DELETE FROM alert_report_exports WHERE expires_at<?").run(now);
  return {...report,cards:report.cards.map(card=>{
    const token=randomBytes(32).toString("base64url"),hash=createHash("sha256").update(token).digest("hex");
    // Persist the exact outgoing rows, not a query that could change with later stock/rule updates.
    db.prepare("INSERT INTO alert_report_exports VALUES(?,?,?,?,?,?)").run(hash,owner,code,JSON.stringify(card),now,now+RETENTION_MS);
    return {...card,exportUrl:`${base}/api/alerts/reports/${token}`};
  })};
}
export function readReportExport(token:string):{warehouseCode:string;card:TurnoverCard}|null {
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
  const row=sqlite().prepare("SELECT warehouse_code,card_json FROM alert_report_exports WHERE token_hash=? AND expires_at>?")
    .get(createHash("sha256").update(token).digest("hex"),Date.now()) as {warehouse_code:string;card_json:string}|undefined;
  return row?{warehouseCode:row.warehouse_code,card:JSON.parse(row.card_json)}:null;
}
