import { sqlite } from './sqlite.mjs';
import { serverConfig } from './server-config';
import { syncTransit, TRANSIT_CHECK_INTERVAL } from './transit-store';

// This job checks applications only; it does not create stock/sales baselines or send alerts.
export async function checkDueTransit(sync=syncTransit,config=serverConfig(),stopping=()=>false){
  if(!config.configured)return;
  const db=sqlite();
  const targets=db.prepare(`SELECT w.owner,w.code,
    (SELECT id FROM stock_snapshots s WHERE s.owner=w.owner AND s.warehouse_code=w.code
      AND s.status='complete' AND s.coverage='auto:v1' ORDER BY captured_at DESC,id DESC LIMIT 1) AS snapshot_id
    FROM warehouses w LEFT JOIN transit_checks c ON c.owner=w.owner AND c.warehouse_code=w.code
    WHERE c.last_attempt IS NULL OR c.last_attempt<=? ORDER BY w.owner,w.code`).all(Date.now()-TRANSIT_CHECK_INTERVAL) as {owner:string;code:string;snapshot_id:string|null}[];
  for(const target of targets){
    if(stopping())break;
    if(!target.snapshot_id)continue;
    try{await sync(target.owner,target.code,target.snapshot_id,config.appkey,config.secret,undefined,undefined,true);}
    catch{console.error(`仓库 ${target.code} 在途检测失败，稍后重试`);}
  }
}
