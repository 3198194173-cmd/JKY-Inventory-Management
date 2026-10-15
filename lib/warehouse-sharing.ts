import { createHash, randomBytes } from 'node:crypto';
import { sqlite } from './sqlite.mjs';
import { AccessError, accountById, audit, prepareCompanyAccount, type Account, type CompanyIdentity } from './accounts';
import { lookupCompanyMobile, normalizeCompanyMobile, verifyDirectoryIdentity } from './dingtalk-login';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function administrator(actor:Account){
  const fresh=accountById(actor.id);
  if(!fresh||fresh.status!=='active'||fresh.role!=='admin'||fresh.member_state!=='verified')throw new AccessError('需要有效管理员权限');
  return fresh;
}
function eligible(account:Account){
  if(account.status!=='active'||account.provider!=='dingtalk'||account.corp_id!==process.env.DINGTALK_CORP_ID||account.member_state==='departed')throw new AccessError('接收账户不可用或不属于本公司');
}
export function warehouseShareOptions(actor:Account){
  const fresh=administrator(actor),db=sqlite();
  return {
    warehouses:db.prepare(`SELECT w.code,w.name,(SELECT COUNT(*) FROM stock_snapshots s WHERE s.owner=w.owner AND s.warehouse_code=w.code AND s.status='complete') AS snapshots
      FROM warehouses w WHERE w.owner=? ORDER BY w.code`).all(fresh.data_owner) as {code:string;name:string;snapshots:number}[],
    accounts:db.prepare(`SELECT id,display_name AS name,dingtalk_user_id AS userId FROM accounts
      WHERE id<>? AND provider='dingtalk' AND corp_id=? AND status='active' AND member_state<>'departed' ORDER BY display_name,id`).all(fresh.id,process.env.DINGTALK_CORP_ID||'') as {id:string;name:string;userId:string}[],
  };
}
export async function findShareRecipient(actor:Account,value:unknown,fetcher:typeof fetch=fetch){
  administrator(actor);const mobile=normalizeCompanyMobile(value),db=sqlite();
  // Persist the rate-limit claim before calling the provider, including failed lookups.
  db.exec('BEGIN IMMEDIATE');
  try{
    administrator(actor);
    const n=Number(db.prepare("SELECT COUNT(*) AS n FROM account_audit WHERE actor_id=? AND action='warehouse_recipient_lookup' AND created_at>?").get(actor.id,new Date(Date.now()-600000).toISOString())!.n);
    if(n>=20)throw new AccessError('查询较频繁，请十分钟后重试',429);
    audit(actor.id,actor.id,'warehouse_recipient_lookup');
    db.prepare('DELETE FROM warehouse_share_candidates WHERE expires_at<=?').run(Date.now());db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  const identity=await lookupCompanyMobile(mobile,fetcher);administrator(actor);
  const existing=db.prepare('SELECT * FROM accounts WHERE corp_id=? AND dingtalk_user_id=?').get(identity.corpId,identity.userId) as Account|undefined;
  if(existing){eligible(existing);if(existing.union_id!==identity.unionId)throw new AccessError('钉钉身份发生变化，请联系管理员');if(existing.id===actor.id)throw new AccessError('请选择其他公司成员',400);}
  const lookupToken=randomBytes(32).toString('base64url'),maskedMobile=mobile.slice(0,3)+'****'+mobile.slice(-4);
  db.prepare('INSERT INTO warehouse_share_candidates VALUES(?,?,?,?,?)').run(hash(lookupToken),actor.id,JSON.stringify(identity),maskedMobile,Date.now()+600000);
  return {lookupToken,name:identity.name,userId:identity.userId,maskedMobile,existingAccount:!!existing};
}

type ShareInput={requestId?:unknown;warehouseCodes?:unknown;lookupToken?:unknown;targetAccountId?:unknown};
export type ShareResult={targetId:string;targetName:string;prepared:boolean;copied:{code:string;name:string;snapshots:number;entries:number;inbound:number;transit:number}[];skipped:string[]};
type Candidate={actor_id:string;identity_json:string;expires_at:number};
function candidate(token:string,actorId:string){
  const row=sqlite().prepare('SELECT * FROM warehouse_share_candidates WHERE token_hash=? AND actor_id=? AND expires_at>?').get(hash(token),actorId,Date.now()) as Candidate|undefined;
  if(!row)throw new AccessError('身份确认已过期，请重新查询手机号',409);
  return JSON.parse(row.identity_json) as CompanyIdentity;
}
function priorResult(requestId:string,actorId:string,requestHash:string){
  const row=sqlite().prepare('SELECT * FROM warehouse_shares WHERE request_id=?').get(requestId) as {actor_id:string;request_hash:string;result_json:string}|undefined;
  if(!row)return;
  if(row.actor_id!==actorId||row.request_hash!==requestHash)throw new AccessError('请求编号已用于其他复制，请重新提交',409);
  return JSON.parse(row.result_json) as ShareResult;
}

// All table names and SQL expressions below are internal constants. Values are bound.
type CopyTable='stock_snapshots'|'stock_entries'|'daily_slots'|'inbound_reconciliations'|'transit_snapshots'|'transit_completion_marks'|'sync_runs';
function copyRows(table:CopyTable,overrides:Record<string,string>,joins:string,where:string,values:(string|number)[]){
  const db=sqlite(),columns=(db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(c=>c.name);
  return Number(db.prepare(`INSERT INTO ${table} (${columns.map(c=>`"${c}"`).join(',')}) SELECT ${columns.map(c=>overrides[c]||`s."${c}"`).join(',')} FROM ${table} s ${joins} WHERE ${where}`).run(...values).changes);
}
function copyWarehouse(source:string,target:string,code:string){
  const db=sqlite(),w=db.prepare('SELECT * FROM warehouses WHERE owner=? AND code=?').get(source,code) as {name:string;warehouse_id:string|null;schedule_enabled:number;daily_time:string;time_zone:string}|undefined;
  if(!w)throw new AccessError('所选仓库已不存在，请刷新后重试',409);
  if(db.prepare('SELECT 1 FROM warehouses WHERE owner=? AND code=?').get(target,code))return null;
  db.prepare('INSERT INTO warehouses(owner,code,name,warehouse_id,schedule_enabled,daily_time,time_zone,created_at) VALUES(?,?,?,?,?,?,?,?)').run(target,code,w.name,w.warehouse_id,w.schedule_enabled,w.daily_time,w.time_zone,new Date().toISOString());
  // Trigger initializes alert settings; copy rules only, never notification grants or enabled state.
  db.prepare(`UPDATE warehouse_alert_settings SET (threshold,turnover_average_threshold,turnover_days,excluded_name_keywords,notify_time)=
    (SELECT threshold,turnover_average_threshold,turnover_days,excluded_name_keywords,notify_time FROM warehouse_alert_settings WHERE owner=? AND warehouse_code=?)
    WHERE owner=? AND warehouse_code=? AND EXISTS(SELECT 1 FROM warehouse_alert_settings WHERE owner=? AND warehouse_code=?)`).run(source,code,target,code,source,code);
  db.exec('CREATE TEMP TABLE IF NOT EXISTS warehouse_share_snapshot_map (old_id TEXT PRIMARY KEY,new_id TEXT NOT NULL UNIQUE); DELETE FROM warehouse_share_snapshot_map;');
  db.prepare("INSERT INTO warehouse_share_snapshot_map SELECT id,lower(hex(randomblob(16))) FROM stock_snapshots WHERE owner=? AND warehouse_code=? AND status='complete'").run(source,code);
  const ownerWhere='s.owner=? AND s.warehouse_code=?',join='JOIN warehouse_share_snapshot_map m ON m.old_id=s.id';
  const snapshots=copyRows('stock_snapshots',{id:'m.new_id',owner:'?'},join,ownerWhere,[target,source,code]);
  const entries=copyRows('stock_entries',{snapshot_id:'m.new_id'},'JOIN warehouse_share_snapshot_map m ON m.old_id=s.snapshot_id','1=1',[]);
  copyRows('daily_slots',{owner:'?',snapshot_id:'m.new_id'},'JOIN warehouse_share_snapshot_map m ON m.old_id=s.snapshot_id',ownerWhere,[target,source,code]);
  const inbound=copyRows('inbound_reconciliations',{owner:'?',before_snapshot_id:'b.new_id',after_snapshot_id:'a.new_id'},'JOIN warehouse_share_snapshot_map b ON b.old_id=s.before_snapshot_id JOIN warehouse_share_snapshot_map a ON a.old_id=s.after_snapshot_id',ownerWhere,[target,source,code]);
  const transit=copyRows('transit_snapshots',{id:'lower(hex(randomblob(16)))',owner:'?',stock_snapshot_id:'m.new_id'},'JOIN warehouse_share_snapshot_map m ON m.old_id=s.stock_snapshot_id',ownerWhere,[target,source,code]);
  copyRows('transit_completion_marks',{owner:'?'},'',ownerWhere,[target,source,code]);
  copyRows('sync_runs',{id:'COALESCE(m.new_id,lower(hex(randomblob(16))))',owner:'?',trigger:"'shared'"},'LEFT JOIN warehouse_share_snapshot_map m ON m.old_id=s.id',ownerWhere+" AND s.status IN ('complete','failed')",[target,source,code]);
  db.exec('DELETE FROM warehouse_share_snapshot_map');
  return {code,name:w.name,snapshots,entries,inbound,transit};
}
export async function shareWarehouses(actor:Account,input:ShareInput,fetcher:typeof fetch=fetch):Promise<ShareResult>{
  administrator(actor);
  if(typeof input.requestId!=='string'||! /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(input.requestId))throw new AccessError('复制请求编号无效',400);
  if(!Array.isArray(input.warehouseCodes)||input.warehouseCodes.length<1||input.warehouseCodes.length>100||input.warehouseCodes.some(c=>typeof c!=='string'||!c||c.length>50))throw new AccessError('请选择要复制的仓库（最多100个）',400);
  const codes=[...new Set(input.warehouseCodes as string[])].sort(),token=typeof input.lookupToken==='string'?input.lookupToken:'',targetId=typeof input.targetAccountId==='string'?input.targetAccountId:'';
  if((!!token)===(!!targetId)||token.length>100||targetId.length>100)throw new AccessError('请确认一位接收人',400);
  const requestHash=hash(JSON.stringify({codes,recipient:token?hash(token):targetId}));
  const previous=priorResult(input.requestId,actor.id,requestHash);if(previous)return previous;
  let identity:CompanyIdentity;
  if(token)identity=candidate(token,actor.id);
  else{
    const target=accountById(targetId);if(!target)throw new AccessError('接收账户不存在',404);eligible(target);
    identity={corpId:target.corp_id!,userId:target.dingtalk_user_id||'',unionId:target.union_id||'',name:target.display_name,avatar:target.avatar_url};
  }
  identity=await verifyDirectoryIdentity(identity,fetcher);
  const db=sqlite();db.exec('BEGIN IMMEDIATE');
  try{
    const fresh=administrator(actor),prior=priorResult(input.requestId,actor.id,requestHash);
    if(prior){db.exec('COMMIT');return prior;}
    if(token){const confirmed=candidate(token,actor.id);if(confirmed.userId!==identity.userId||confirmed.unionId!==identity.unionId||confirmed.corpId!==identity.corpId)throw new AccessError('身份确认不一致',409);}
    if(targetId){const target=accountById(targetId);if(!target)throw new AccessError('接收账户不存在',404);eligible(target);if(target.dingtalk_user_id!==identity.userId||target.union_id!==identity.unionId)throw new AccessError('接收账户身份已变化',409);}
    const existing=db.prepare('SELECT * FROM accounts WHERE corp_id=? AND dingtalk_user_id=?').get(identity.corpId,identity.userId) as Account|undefined;
    if(existing)eligible(existing);
    const target=prepareCompanyAccount(identity);eligible(target);
    if(target.id===fresh.id)throw new AccessError('不能复制到自己的账户',400);
    const result:ShareResult={targetId:target.id,targetName:target.display_name,prepared:!target.last_login_at,copied:[],skipped:[]};
    for(const code of codes){const copied=copyWarehouse(fresh.data_owner,target.data_owner,code);if(copied)result.copied.push(copied);else result.skipped.push(code);}
    audit(fresh.id,target.id,'warehouse_share',{copied:result.copied,skipped:result.skipped,prepared:result.prepared});
    db.prepare('INSERT INTO warehouse_shares VALUES(?,?,?,?,?,?)').run(input.requestId,actor.id,target.id,requestHash,JSON.stringify(result),new Date().toISOString());
    if(token)db.prepare('DELETE FROM warehouse_share_candidates WHERE token_hash=?').run(hash(token));
    db.exec('COMMIT');return result;
  }catch(e){db.exec('ROLLBACK');throw e;}
}
