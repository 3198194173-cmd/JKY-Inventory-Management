import { sqlite } from './sqlite.mjs';
import { AccessError, type Account, accountById, audit, enterpriseGroups } from './accounts';
export function enterpriseGroupCatalog(){
  return enterpriseGroups();
}
export function saveGroupGrants(actor:Account,id:string,value:unknown){
  if(actor.role!=='admin'||actor.status!=='active')throw new AccessError('需要管理员权限');
  if(!Array.isArray(value)||value.length>1000||value.some(v=>typeof v!=='string'))throw new AccessError('群授权无效',400);
  const target=accountById(id);if(!target)throw new AccessError('账户不存在',404);
  const catalog=enterpriseGroupCatalog(),available=new Map(catalog.map(g=>[g.id,g])),ids=[...new Set(value as string[])];
  if(ids.some(g=>!available.has(g)))throw new AccessError('群目录已变化，请先由管理员同步企业群',409);
  const db=sqlite(),client=process.env.DINGTALK_CLIENT_ID||'',robot=process.env.DINGTALK_ROBOT_CODE||'',now=new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try{
    const fresh=accountById(actor.id);if(fresh?.role!=='admin'||fresh.status!=='active')throw new AccessError('权限已变化');
    db.prepare('DELETE FROM account_group_grants WHERE data_owner=? AND client_id=? AND robot_code=?').run(target.data_owner,client,robot);
    for(const group of ids){
      db.prepare('INSERT INTO account_group_grants VALUES(?,?,?,?,?,?)').run(target.data_owner,client,robot,group,actor.id,now);
      db.prepare(`INSERT INTO dingtalk_groups(owner,client_id,robot_code,open_conversation_id,name,last_seen_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(owner,client_id,robot_code,open_conversation_id) DO UPDATE SET active=1,name=excluded.name,last_seen_at=excluded.last_seen_at`).run(target.data_owner,client,robot,group,available.get(group)!.name,now);
    }
    if(target.role!=='admin')db.prepare('DELETE FROM warehouse_alert_groups WHERE owner=? AND client_id=? AND robot_code=? AND open_conversation_id NOT IN (SELECT value FROM json_each(?))').run(target.data_owner,client,robot,JSON.stringify(ids));
    audit(actor.id,id,'group_grants_update',{groups:ids});db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
}
