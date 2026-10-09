import { sqlite } from './sqlite.mjs';
import { collectTransit, transitMetric, type TransitDocument, type TransitResult, type TransitMetric } from './transit';
import type { InventoryView } from './inventory-types';

type Stored={stock_snapshot_id:string;captured_at:string;status:string;payload:string|null;error:string|null};
export function transitSnapshot(owner:string,code:string,snapshotId?:string):{record:Stored|null;data:TransitResult|null} {
  const db=sqlite();
  const record=(snapshotId?db.prepare('SELECT * FROM transit_snapshots WHERE owner=? AND warehouse_code=? AND stock_snapshot_id=?').get(owner,code,snapshotId):db.prepare('SELECT * FROM transit_snapshots WHERE owner=? AND warehouse_code=? ORDER BY captured_at DESC,rowid DESC LIMIT 1').get(owner,code)) as Stored|undefined;
  return {record:record||null,data:record?.payload?JSON.parse(record.payload):null};
}
export async function syncTransit(owner:string,code:string,snapshotId:string,appkey:string,secret:string,progress:(n:number)=>Promise<void>=async()=>{},collector=collectTransit){
  const db=sqlite(),previous=transitSnapshot(owner,code);
  // Failed queries must not erase the set of outstanding documents being watched.
  const prior=previous.data || (()=>{const r=db.prepare("SELECT payload FROM transit_snapshots WHERE owner=? AND warehouse_code=? AND payload IS NOT NULL ORDER BY captured_at DESC,rowid DESC LIMIT 1").get(owner,code) as {payload:string}|undefined;return r?JSON.parse(r.payload) as TransitResult:null;})();
  try{
    const result=await collector(appkey,secret,code,prior?.documents||[],fetch,progress);
    const status=result.issues.length?'unresolved':'complete';
    db.prepare('INSERT OR REPLACE INTO transit_snapshots VALUES (?,?,?,?,?,?,?)').run(snapshotId,owner,code,result.completedAt,status,JSON.stringify(result),result.issues.join('；')||null);
    return status==='complete'?`在途核验完成：${result.goods.filter(g=>g.quantity!=='0').length} 个商品`:`在途待核验：${result.issues.join('；')}`;
  }catch(error){
    const message=error instanceof Error?error.message:'在途查询失败';
    db.prepare('INSERT OR REPLACE INTO transit_snapshots VALUES (?,?,?,?,?,?,?)').run(snapshotId,owner,code,new Date().toISOString(),'failed',null,message);
    return `在途未更新：${message}；历史记录已保留`;
  }
}
export function enrichTransit(owner:string,code:string,snapshotId:string,rows:InventoryView['rows']){
  const {record,data}=transitSnapshot(owner,code,snapshotId),currentScope=data?.scope==='transfer-v1',byGoods=new Map(data?.goods.map(g=>[g.goodsNo,g])||[]);
  for(const row of rows){const item=byGoods.get(row.goodsNo);row.transit=transitMetric(currentScope&&record?.status==='complete'&&(!item||item.unitName===row.unitName)?item?.quantity||'0':null,row.quantity,row.metrics);if(data&&!currentScope)row.transit.reason='请重新采集以核验调拨入库在途';if(item&&item.unitName!==row.unitName)row.transit.reason='库存与在途单位不同，待核验';}
  return {status:data&&!currentScope?'pending':record?.status||'pending',checkedAt:record?.captured_at||null,error:data&&!currentScope?'请重新采集以核验调拨入库在途':record?.error||null};
}
export type TransitHistoryView={scope?:'transfer-v1';dates:string[];selected:string;status:string;error:string|null;from:string|null;documents:TransitDocument[];goods:{goodsNo:string;goodsName:string;unitName:string;quantity:string|null;stock:string|null}[]};
export function loadTransitHistory(owner:string,code:string,requested='',goodsNo=''):TransitHistoryView {
  const db=sqlite();
  if(!db.prepare('SELECT 1 FROM warehouses WHERE owner=? AND code=?').get(owner,code))throw new Error('仓库不存在');
  if(requested&&!/^\d{4}-\d\d-\d\d$/.test(requested))throw new Error('日期无效');
  const dates=(db.prepare("SELECT DISTINCT date(captured_at,'+8 hours') AS date FROM transit_snapshots WHERE owner=? AND warehouse_code=? ORDER BY date DESC").all(owner,code) as {date:string}[]).map(r=>r.date);
  const selected=requested||dates[0]||'';
  const stored=db.prepare("SELECT * FROM transit_snapshots WHERE owner=? AND warehouse_code=? AND date(captured_at,'+8 hours')=? ORDER BY captured_at DESC,rowid DESC LIMIT 1").get(owner,code,selected) as Stored|undefined;
  const data:TransitResult|null=stored?.payload?JSON.parse(stored.payload):null;
  const stock=stored?db.prepare('SELECT goods_no,quantity,unit_name FROM stock_entries WHERE snapshot_id=?').all(stored.stock_snapshot_id) as {goods_no:string;quantity:string;unit_name:string}[]:[];
  const byStock=new Map(stock.map(r=>[r.goods_no,r]));
  // Later captures omit settled applications. Preserve their completion event
  // in that day's history, while totals always use the latest capture only.
  const documents=new Map<string,TransitDocument>();
  if(data){
    const captures=db.prepare("SELECT payload FROM transit_snapshots WHERE owner=? AND warehouse_code=? AND date(captured_at,'+8 hours')=? AND payload IS NOT NULL ORDER BY captured_at,rowid").all(owner,code,selected) as {payload:string}[];
    for(const capture of captures)for(const doc of (JSON.parse(capture.payload) as TransitResult).documents){
      if(data.scope==='transfer-v1'&&doc.inType!=='102')continue;
      if(doc.state==='3'||doc.audit==='3')documents.set(doc.id,doc);
      else documents.delete(doc.id);
    }
    for(const doc of data.documents)documents.set(doc.id,doc);
  }
  return {scope:data?.scope,dates,selected,status:stored?.status||'pending',error:stored?.error||null,from:data?.from||null,
    documents:[...documents.values()].filter(d=>!goodsNo||d.lines.some(l=>l.goodsNo===goodsNo)).map(d=>({...d,lines:d.lines.filter(l=>!goodsNo||l.goodsNo===goodsNo),receipts:d.receipts?.filter(r=>!goodsNo||r.goodsNo===goodsNo)})),
    goods:(data?.goods||[]).filter(g=>!goodsNo||g.goodsNo===goodsNo).map(g=>({...g,quantity:stored?.status==='complete'?g.quantity:null,stock:byStock.get(g.goodsNo)?.unit_name===g.unitName?byStock.get(g.goodsNo)!.quantity:null}))};
}
export function transitOnlyGoods(owner:string,code:string,snapshotId:string){
  const {record,data}=transitSnapshot(owner,code,snapshotId);if(record?.status!=='complete'||data?.scope!=='transfer-v1')return [];
  const known=new Set((sqlite().prepare('SELECT goods_no FROM stock_entries WHERE snapshot_id=?').all(snapshotId) as {goods_no:string}[]).map(r=>r.goods_no));
  return data.goods.filter(g=>!known.has(g.goodsNo)&&g.quantity!=='0');
}
export type {TransitMetric};
