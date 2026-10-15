import { createHash, randomUUID } from 'node:crypto';
import { sqlite } from './sqlite.mjs';

export type Account = { id:string; data_owner:string; provider:'local'|'dingtalk'; corp_id:string|null; dingtalk_user_id:string|null; union_id:string|null; display_name:string; avatar_url:string; role:'admin'|'member'; status:'active'|'disabled'|'archived'; member_state:string; membership_checked_at:number; created_at:string; updated_at:string; last_login_at:string|null };
export class AccessError extends Error { constructor(message:string,public status=403){super(message);} }
export const companyLoginEnabled = () => process.env.INVENTORY_DINGTALK_LOGIN_ENABLED === 'true';
export const localLoginEnabled = () => process.env.INVENTORY_LOCAL_LOGIN_ENABLED === 'true' || (!companyLoginEnabled() && process.env.INVENTORY_LOCAL_LOGIN_ENABLED !== 'false');
export const legacyOwner = () => process.env.INVENTORY_OWNER_ID || 'admin';
export const accountById = (id:string) => sqlite().prepare('SELECT * FROM accounts WHERE id=?').get(id) as Account|undefined;
export const accountByOwner = (owner:string) => sqlite().prepare('SELECT * FROM accounts WHERE data_owner=?').get(owner) as Account|undefined;
export function audit(actorId:string,targetId:string,action:string,detail:Record<string,unknown>={}) {
  sqlite().prepare('INSERT INTO account_audit VALUES(?,?,?,?,?,?)').run(randomUUID(),actorId,targetId,action,JSON.stringify(detail),new Date().toISOString());
}
export function legacyAccount() {
  const db=sqlite(),owner=legacyOwner(),now=new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO accounts(id,data_owner,provider,display_name,role,member_state,created_at,updated_at) VALUES(?,?,'local',?,'admin','verified',?,?)")
    .run('legacy-'+createHash('sha256').update(owner).digest('hex').slice(0,24),owner,process.env.INVENTORY_USERNAME||'admin',now,now);
  return accountByOwner(owner)!;
}
export type CompanyIdentity = {corpId:string;userId:string;unionId:string;name:string;avatar:string};
export function bindCompanyAccount(identity:CompanyIdentity) {
  if(identity.corpId!==process.env.DINGTALK_CORP_ID || !identity.userId || !identity.unionId)throw new AccessError('仅允许本公司钉钉成员登录');
  const db=sqlite(),now=new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    let account=db.prepare('SELECT * FROM accounts WHERE corp_id=? AND dingtalk_user_id=?').get(identity.corpId,identity.userId) as Account|undefined;
    if(account && account.union_id && account.union_id!==identity.unionId)throw new AccessError('钉钉身份发生变化，请联系管理员');
    if(!account){
      const adminUser=process.env.DINGTALK_ADMIN_USER_ID,adminUnion=process.env.DINGTALK_ADMIN_UNION_ID;
      const designated=!!(adminUser||adminUnion)&&(!adminUser||identity.userId===adminUser)&&(!adminUnion||identity.unionId===adminUnion);
      if(designated){
        account=legacyAccount();
        if(account.provider!=='local')throw new AccessError('历史账户已绑定其他身份，请核对管理员配置');
        db.prepare("UPDATE accounts SET provider='dingtalk',corp_id=?,dingtalk_user_id=?,union_id=? WHERE id=?").run(identity.corpId,identity.userId,identity.unionId,account.id);
        audit(account.id,account.id,'bind_legacy_admin');
      }else{
        const id=randomUUID(),owner='account:'+randomUUID();
        db.prepare("INSERT INTO accounts(id,data_owner,provider,corp_id,dingtalk_user_id,union_id,display_name,role,created_at,updated_at) VALUES(?,?,'dingtalk',?,?,?,?,'member',?,?)").run(id,owner,identity.corpId,identity.userId,identity.unionId,identity.name,now,now);
        account=accountById(id)!;audit(id,id,'account_created');
      }
    }
    if(account.status!=='active')throw new AccessError('账号已禁用或归档，请联系管理员');
    db.prepare("UPDATE accounts SET display_name=?,avatar_url=?,member_state='verified',membership_checked_at=?,last_login_at=?,updated_at=? WHERE id=?").run(identity.name,identity.avatar,Date.now(),now,now,account.id);
    audit(account.id,account.id,'login_dingtalk');
    db.exec('COMMIT');return accountById(account.id)!;
  }catch(e){db.exec('ROLLBACK');throw e;}
}
export function revokeAccountSessions(id:string){
  const account=accountById(id);if(!account)return;
  sqlite().prepare('DELETE FROM account_sessions WHERE account_id=?').run(id);
  sqlite().prepare('DELETE FROM local_sessions WHERE owner=?').run(account.data_owner);
}
export function assertOwnerActive(owner:string){
  const account=accountByOwner(owner);
  if(!account && !companyLoginEnabled())return;
  if(account?.provider==='dingtalk'&&!companyLoginEnabled()&&owner!==legacyOwner())throw new AccessError('钉钉登录已关闭，该账户任务已暂停');
  if(!account || account.status!=='active' || (companyLoginEnabled() && (account.provider!=='dingtalk' || account.member_state!=='verified')))throw new AccessError('账户不可用，任务或发送已停止');
}
export function markDeparted(id:string){
  const account=accountById(id);if(!account)return;
  sqlite().prepare("UPDATE accounts SET member_state='departed',membership_checked_at=0,updated_at=? WHERE id=?").run(new Date().toISOString(),id);
  revokeAccountSessions(id);cancelAccountJobs(account.data_owner);audit('system',id,'membership_removed');
}
export function cancelAccountJobs(owner:string){
  sqlite().prepare("UPDATE local_jobs SET state='failed',message='账户不可用，任务已取消',updated_at=? WHERE owner=? AND state='queued'").run(new Date().toISOString(),owner);
}
export function manageAccount(actor:Account,id:string,change:{role?:unknown;status?:unknown;revokeSessions?:unknown}){
  if(actor.role!=='admin'||actor.status!=='active')throw new AccessError('需要管理员权限');
  if(change.role!==undefined&&!['admin','member'].includes(String(change.role)))throw new AccessError('角色无效',400);
  if(change.status!==undefined&&!['active','disabled','archived'].includes(String(change.status)))throw new AccessError('账户状态无效',400);
  const db=sqlite();db.exec('BEGIN IMMEDIATE');
  try{
    const fresh=accountById(actor.id),target=accountById(id);
    if(fresh?.role!=='admin'||fresh.status!=='active'||!target)throw new AccessError('账户不存在或权限已变化');
    const role=change.role===undefined?target.role:String(change.role),status=change.status===undefined?target.status:String(change.status);
    if(target.role==='admin'&&target.status==='active'&&(role!=='admin'||status!=='active')){
      const others=db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE role='admin' AND status='active' AND member_state='verified' AND id<>?").get(id)!;
      if(Number(others.n)<1)throw new AccessError('必须保留至少一名有效管理员',409);
    }
    db.prepare('UPDATE accounts SET role=?,status=?,updated_at=? WHERE id=?').run(role,status,new Date().toISOString(),id);
    if(role!==target.role||status!==target.status||change.revokeSessions===true)revokeAccountSessions(id);
    if(status!=='active')cancelAccountJobs(target.data_owner);
    audit(actor.id,id,'account_update',{role,status,revokeSessions:change.revokeSessions===true});
    db.exec('COMMIT');return accountById(id)!;
  }catch(e){db.exec('ROLLBACK');throw e;}
}
export function groupAllowed(owner:string,id:string){
  const ids=permittedGroupIds(owner);return ids===null||ids.has(id);
}
export function permittedGroupIds(owner:string):Set<string>|null{
  const account=accountByOwner(owner);if(!account&&!companyLoginEnabled())return null;
  if(!account||account.status!=='active')return new Set();
  const client=process.env.DINGTALK_CLIENT_ID||'',robot=process.env.DINGTALK_ROBOT_CODE||'';
  const available=new Set(enterpriseGroups().map(g=>g.id));
  if(account.role==='admin')return sqlite().prepare('SELECT 1 FROM enterprise_robot_sync WHERE client_id=? AND robot_code=?').get(client,robot)?available:null;
  const grants=sqlite().prepare('SELECT open_conversation_id FROM account_group_grants WHERE data_owner=? AND client_id=? AND robot_code=?').all(owner,client,robot);
  return new Set(grants.map((r:{open_conversation_id:string})=>r.open_conversation_id).filter((id:string)=>available.has(id)));
}
export function enterpriseGroups(){
  const db=sqlite(),client=process.env.DINGTALK_CLIENT_ID||'',robot=process.env.DINGTALK_ROBOT_CODE||'';
  if(db.prepare('SELECT 1 FROM enterprise_robot_sync WHERE client_id=? AND robot_code=?').get(client,robot))return db.prepare('SELECT open_conversation_id AS id,name FROM enterprise_robot_groups WHERE client_id=? AND robot_code=? AND active=1 ORDER BY name,id').all(client,robot) as {id:string;name:string}[];
  // Before the first catalog sync, preserve verified groups from the legacy administrator only.
  return db.prepare(`SELECT g.open_conversation_id AS id,MAX(g.name) AS name FROM dingtalk_groups g JOIN accounts a ON a.data_owner=g.owner
    WHERE a.role='admin' AND a.status='active' AND g.active=1 AND g.client_id=? AND g.robot_code=? GROUP BY g.open_conversation_id ORDER BY name,id`).all(client,robot) as {id:string;name:string}[];
}
export function canDiscoverGroups(owner:string){const a=accountByOwner(owner);return a?a.role==='admin'&&a.status==='active':!companyLoginEnabled();}
