import { sqlite } from './sqlite.mjs';
import { AccessError, groupAllowed } from './accounts';
import { ensureOwnerAccess } from './dingtalk-login';
export async function assertDelivery(owner:string,code:string,groupId:string,revision:number){
  await ensureOwnerAccess(owner);
  if(!groupAllowed(owner,groupId))throw new AccessError('账户的群授权已撤销，发送已停止');
  const row=sqlite().prepare(`SELECT 1 FROM warehouse_alert_groups s JOIN dingtalk_groups g
    ON g.owner=s.owner AND g.client_id=s.client_id AND g.robot_code=s.robot_code AND g.open_conversation_id=s.open_conversation_id
    JOIN warehouse_alert_settings a ON a.owner=s.owner AND a.warehouse_code=s.warehouse_code
    WHERE s.owner=? AND s.client_id=? AND s.robot_code=? AND s.warehouse_code=? AND s.open_conversation_id=? AND g.active=1 AND a.revision=?`)
    .get(owner,process.env.DINGTALK_CLIENT_ID||'',process.env.DINGTALK_ROBOT_CODE||'',code,groupId,revision);
  if(!row)throw new AccessError('群选择或预警设置已变化，发送已停止');
}
