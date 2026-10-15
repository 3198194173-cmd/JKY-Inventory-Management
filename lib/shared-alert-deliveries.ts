import { createHash, randomUUID } from 'node:crypto';
import { sqlite } from './sqlite.mjs';
import { normalizeQuantity } from './decimal';
import type { TurnoverCard } from './dingtalk-card-data';

type Report={date:string;cards:TurnoverCard[]};
export function sharedReportHash(report:Report){
  const number=(v:string|null|undefined)=>v==null?null:v==='—'?v:normalizeQuantity(v);
  const rows=report.cards.flatMap(card=>card.rows.map(r=>({goodsNo:r.goodsNo,goodsName:r.goodsName,unitName:r.unitName,
    quantity:number(r.quantity),average:number(r.average),turnover:number(r.turnover),transit:number(r.transit),replenishment:number(r.replenishment),
    sales:card.dates.map((date,i)=>[date,number(r.sales[i])]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))}))).sort((a,b)=>a.goodsNo<b.goodsNo?-1:a.goodsNo>b.goodsNo?1:0);
  // Do not hash account owners, generated IDs, capture times, warehouse aliases,
  // export tokens or delivery format. They do not change the business report.
  return createHash('sha256').update(JSON.stringify({v:1,corp:process.env.DINGTALK_CORP_ID||'',date:report.date,rows})).digest('hex');
}
export function claimSharedAlert(scope:[string,string,string],groupId:string,code:string,reportHash:string){
  const [owner,client,robot]=scope,token=randomUUID(),now=new Date().toISOString(),db=sqlite();
  const changed=db.prepare(`INSERT INTO shared_alert_deliveries(client_id,robot_code,group_id,warehouse_code,report_hash,owner,claim_token,state,attempted_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'sending',?,?) ON CONFLICT(client_id,robot_code,group_id,warehouse_code,report_hash) DO UPDATE
    SET owner=excluded.owner,claim_token=excluded.claim_token,state='sending',accepted_parts=0,attempted_at=excluded.attempted_at,updated_at=excluded.updated_at
    WHERE shared_alert_deliveries.state='rejected'`).run(client,robot,groupId,code,reportHash,owner,token,now,now);
  if(changed.changes)return {token,state:'sending' as const};
  const row=db.prepare('SELECT state FROM shared_alert_deliveries WHERE client_id=? AND robot_code=? AND group_id=? AND warehouse_code=? AND report_hash=?').get(client,robot,groupId,code,reportHash) as {state:'sending'|'accepted'|'unconfirmed'|'rejected'};
  return {token:null,state:row.state};
}
export function finishSharedAlert(token:string,state:'accepted'|'unconfirmed'|'rejected',parts:number){
  sqlite().prepare('UPDATE shared_alert_deliveries SET state=?,accepted_parts=?,updated_at=? WHERE claim_token=?').run(state,parts,new Date().toISOString(),token);
}
