import { assertSameOrigin, errorResponse, requireAdmin } from '@/lib/auth';
import { manageAccount, accountById, AccessError } from '@/lib/accounts';
import { enterpriseGroupCatalog, saveGroupGrants } from '@/lib/account-groups';
import { syncRobotGroups } from '@/lib/dingtalk-groups-store';
import { sqlite } from '@/lib/sqlite.mjs';
export async function GET(){
  try{
    await requireAdmin();const db=sqlite();
    const accounts=db.prepare(`SELECT a.id,a.display_name AS name,a.role,a.status,a.provider,a.member_state AS memberState,a.last_login_at AS lastLoginAt,
      (SELECT COUNT(*) FROM warehouses w WHERE w.owner=a.data_owner) AS warehouses,
      (SELECT COUNT(*) FROM stock_snapshots s WHERE s.owner=a.data_owner AND s.status='complete') AS snapshots,
      (SELECT COUNT(*) FROM account_sessions s WHERE s.account_id=a.id AND s.expires_at>?) AS sessions,
      (SELECT json_group_array(open_conversation_id) FROM account_group_grants g WHERE g.data_owner=a.data_owner AND g.client_id=? AND g.robot_code=?) AS groups
      FROM accounts a ORDER BY a.created_at,a.id`).all(Date.now(),process.env.DINGTALK_CLIENT_ID||'',process.env.DINGTALK_ROBOT_CODE||'').map((a:Record<string,unknown>)=>({...a,groups:JSON.parse(String(a.groups||'[]'))}));
    const audit=db.prepare(`SELECT l.id,l.action,l.detail,l.created_at AS createdAt,COALESCE(a.display_name,l.actor_id) AS actor,COALESCE(t.display_name,l.target_id) AS target
      FROM account_audit l LEFT JOIN accounts a ON a.id=l.actor_id LEFT JOIN accounts t ON t.id=l.target_id ORDER BY l.created_at DESC,l.rowid DESC LIMIT 50`).all();
    return Response.json({accounts,groups:enterpriseGroupCatalog(),audit},{headers:{'Cache-Control':'no-store'}});
  }catch(e){return errorResponse(e);}
}
export async function PATCH(request:Request){
  try{
    assertSameOrigin(request);const actor=await requireAdmin(),body=await request.json() as Record<string,unknown>;
    if(body.syncGroups===true){await syncRobotGroups(actor.data_owner,{force:true});return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}});}
    const id=String(body.accountId||'');if(!accountById(id))throw new AccessError('账户不存在',404);
    // A request changes either permissions or account status, never half of both.
    if(body.groups!==undefined)saveGroupGrants(actor,id,body.groups);
    else manageAccount(actor,id,{role:body.role,status:body.status,revokeSessions:body.revokeSessions});
    return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}});
  }catch(e){return errorResponse(e);}
}
