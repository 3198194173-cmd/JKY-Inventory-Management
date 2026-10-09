import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {collectTransit,transitMetric} from '../lib/transit';
import {syncTransit,enrichTransit,loadTransitHistory,transitOnlyGoods} from '../lib/transit-store';
import {sqlite} from '../lib/sqlite.mjs';
import {inventoryWorkbook} from '../lib/excel';
import {addWarehouse} from '../lib/inventory-store';
import type {InventoryView} from '../lib/inventory-types';

type Row=Record<string,string|number|null>;
function fixture(state='1',remaining='1000',count=1){
  const received=String(1000-Number(remaining));
  const parent:Row={inId:'90071992547409931',inNo:'RK-old',inWarehouseCode:'A',inType:'102',inStatus:state,status:'2',skuCount:String(1000*count),innerCount:String(Number(received)*count),uninnerCount:String(Number(remaining)*count)};
  const rows:Row[]=Array.from({length:count},(_,i)=>({...parent,inDetailId:'detail-'+i,goodsNo:'G'+i,goodsName:'商品'+i,skuId:'sku'+i,unitName:'Pcs',skuCount:'1000',innerCount:received,uninnerCount:remaining}));
  const calls:Record<string,unknown>[]=[];
  const fetcher=(async(_url:unknown,init:RequestInit)=>{const params=new URLSearchParams(String(init.body)),args=JSON.parse(params.get('bizcontent')!);calls.push(args);let data:Row[]=[];
    if(params.get('method')==='erp.stockin.get')data=(!args.inStatus||args.inStatus===state)&&(!args.inNo||args.inNo===parent.inNo)?[parent]:[];
    else if(params.get('method')==='erp.stockin.get.v2')data=rows;
    else data=args.archived?[]:rows.map((r,i)=>({warehouseCode:'A',recId:'rec'+i,goodsdocNo:'CRK-1',billNo:parent.inNo,goodsNo:r.goodsNo,skuId:r.skuId,unitName:'Pcs',quantity:received,inOutDate:'2026-10-09 08:00:00'}));
    return Response.json({code:200,subCode:'success',result:{noPrivilegeItem:null,pageInfo:{total:0},data:data.slice(args.pageIndex*50,(args.pageIndex+1)*50)}});
  }) as typeof fetch;
  return {parent,rows,calls,fetcher};
}

test('在途完整分页、不依赖total；未入库与部分入库用精确剩余数量',async()=>{
  const first=fixture('1','1000',53),result=await collectTransit('key','secret','A',[],first.fetcher);
  assert.equal(result.issues.length,0);assert.equal(result.goods.length,53);assert.equal(result.goods[0].quantity,'1000');assert.ok(first.calls.some(c=>c.pageIndex===2));assert.ok(first.calls.every(c=>c.inType==='102'));assert.equal(result.scope,'transfer-v1');
  const partial=fixture('2','600'),next=await collectTransit('key','secret','A',result.documents,partial.fetcher);
  assert.equal(next.goods[0].quantity,'600');assert.equal(next.documents[0].lines[0].received,'400');assert.equal(next.documents[0].receiptStatus,'实际入库已对账');
  assert.ok(partial.calls.every(c=>c.isNotification===0||c.billNo));
});
test('等待变完成复查单号全状态，核对实际入库，剩余归零并保留其他单据',async()=>{
  const wait=fixture(),before=await collectTransit('key','secret','A',[],wait.fetcher);
  const completed=fixture('3','0'),after=await collectTransit('key','secret','A',before.documents,completed.fetcher);
  assert.equal(after.goods.length,0);assert.equal(after.documents[0].state,'3');assert.equal(after.documents[0].receiptStatus,'实际入库已对账');
  assert.ok(completed.calls.some(c=>c.inNo==='RK-old'&&!c.inStatus));assert.ok(completed.calls.some(c=>c.billNo==='RK-old'));
});
test('消失不等于完成；部分入库缺少数量或数量冲突不补零',async()=>{
  const f=fixture(),before=await collectTransit('key','secret','A',[],f.fetcher);
  const empty=(async()=>Response.json({code:200,result:{data:[]}})) as typeof fetch;
  const missing=await collectTransit('key','secret','A',before.documents,empty);assert.ok(missing.issues[0].includes('不能确认完成'));assert.equal(missing.documents[0].lines[0].remaining,'1000');
  const partial=fixture('2','600');(partial.rows[0] as Row).uninnerCount=null;
  const invalid=await collectTransit('key','secret','A',[],partial.fetcher);assert.ok(invalid.issues.length);assert.equal(invalid.goods.length,0);
});
test('仓库不一致、权限受限、重复页及请求失败拒绝发布部分结果',async()=>{
  const f=fixture();f.parent.inWarehouseCode='B';await assert.rejects(collectTransit('key','secret','A',[],f.fetcher),/仓库/);
  await assert.rejects(collectTransit('key','secret','A',[],(async()=>Response.json({code:200,result:{data:[],noPrivilegeItem:['quantity']}})) as typeof fetch),/权限/);
  const repeated=fixture();await assert.rejects(collectTransit('key','secret','A',[],(async()=>Response.json({code:200,result:{data:[repeated.parent]}})) as typeof fetch),/重复/);
});
test('补货按库存加在途除以均值乘30，精确判断不足30天并取整',()=>{
  const metrics={total7:'70',average7:'10',validDays:7,basis:'inventory_difference',reason:null,turnoverDays:'10'} as const;
  assert.deepEqual(transitMetric('50','100',metrics),{quantity:'50',coverageDays:'15',replenishment:'450',reason:null});
  assert.equal(transitMetric('300','100',metrics).replenishment,'0');assert.equal(transitMetric('0','-10',metrics).replenishment,'0');
  assert.equal(transitMetric(null,'100',metrics).replenishment,null);assert.equal(transitMetric('0','100',{...metrics,total7:'0'}).replenishment,null);
  assert.equal(transitMetric('0','1',{...metrics,total7:'1',average7:'0.14'}).replenishment,'210');
  assert.equal(transitMetric('0','0.1667',metrics).replenishment,'1');
  assert.equal(transitMetric('0','0.1666',metrics).replenishment,'0');
  assert.equal(transitMetric('0','299.5',metrics).replenishment,'899');
  assert.equal(transitMetric('0','299.999',metrics).replenishment,'900');
  assert.equal(transitMetric('0','300',metrics).replenishment,'0');
});

mkdirSync('.sites-runtime/tests',{recursive:true});
process.env.INVENTORY_DB_PATH=resolve(`.sites-runtime/tests/transit-${Date.now()}.sqlite`);
test('在途按仓库和快照隔离、失败保留历史；仅在途商品不伪造库存',async()=>{
  const db=sqlite();await addWarehouse('owner','A','A');await addWarehouse('owner','B','B');
  const shot=(id:string,code:string)=>db.prepare("INSERT INTO stock_snapshots (id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,coverage) VALUES(?,'owner','2026-10-09',?,'complete',1,1,1,'{}',0,0,?,'auto:v1')").run(id,new Date().toISOString(),code);
  shot('s1','A');shot('s2','A');shot('b1','B');
  const first=await collectTransit('key','secret','A',[],fixture().fetcher);
  await syncTransit('owner','A','s1','key','secret',async()=>{},async()=>first);
  const rows:InventoryView['rows']=[{goodsNo:'G0',goodsName:'g',unitName:'Pcs',quantity:'100',skuCount:1,history:{}}];
  enrichTransit('owner','A','s1',rows);assert.equal(rows[0].transit?.quantity,'1000');
  enrichTransit('owner','B','b1',rows);assert.equal(rows[0].transit?.quantity,null);
  assert.equal(transitOnlyGoods('owner','A','s1')[0].quantity,'1000');assert.equal(loadTransitHistory('owner','A').goods[0].stock,null);
  await syncTransit('owner','A','s2','key','secret',async()=>{},async()=>{throw new Error('离线');});
  enrichTransit('owner','A','s2',rows);assert.equal(rows[0].transit?.quantity,null);enrichTransit('owner','A','s1',rows);assert.equal(rows[0].transit?.quantity,'1000');
  assert.throws(()=>loadTransitHistory('other','A'),/仓库/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM transit_snapshots').get()!.n,2);
});


test('完成单当天后续采集不丢失完成记录；在途数量以最新为准',async()=>{
  const db=sqlite();
  for(const id of ['done','later'])db.prepare("INSERT INTO stock_snapshots (id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,coverage) VALUES(?,'owner','2026-10-09',?,'complete',1,1,1,'{}',0,0,'A','auto:v1')").run(id,new Date().toISOString());
  const wait=await collectTransit('key','secret','A',[],fixture().fetcher);
  const done=await collectTransit('key','secret','A',wait.documents,fixture('3','0').fetcher);
  await syncTransit('owner','A','done','k','s',async()=>{},async()=>done);
  const later={...done,documents:[],goods:[],completedAt:new Date(Date.now()+1000).toISOString()};
  await syncTransit('owner','A','later','k','s',async()=>{},async()=>later);
  const history=loadTransitHistory('owner','A');assert.equal(history.documents[0].state,'3');assert.equal(history.goods.length,0);
});

test('已完成但实际入库未对账的申请继续跟踪',async()=>{
  const wait=await collectTransit('k','s','A',[],fixture().fetcher);
  const done=await collectTransit('k','s','A',wait.documents,fixture('3','0').fetcher);
  done.documents[0].receiptStatus='实际入库关联待核验';
  const follow=await collectTransit('k','s','A',done.documents,fixture('3','0').fetcher);
  assert.equal(follow.documents[0].receiptStatus,'实际入库已对账');assert.equal(follow.goods.length,0);
});

test('关闭申请不计在途，审核状态或计量单位未知时不发布零在途',async()=>{
  const closed=fixture();closed.parent.status='3';closed.rows[0].status='3';
  assert.equal((await collectTransit('k','s','A',[],closed.fetcher)).goods.length,0);
  const invalid=fixture();delete invalid.parent.status;assert.ok((await collectTransit('k','s','A',[],invalid.fetcher)).issues.length);
  const units=fixture('1','1000',2);units.rows[1].goodsNo=units.rows[0].goodsNo;units.rows[1].unitName='Box';
  assert.ok((await collectTransit('k','s','A',[],units.fetcher)).issues.some(i=>i.includes('单位')));
});


test('导出在途和补货数值，未取得库存的在途商品不填零库存',()=>{
  const rows=[{goodsNo:'WITH-STOCK',goodsName:'商品',unitName:'Pcs',quantity:'100.5',skuCount:1,history:{},transit:transitMetric('50','100.5',{total7:'70',average7:'10',validDays:7,basis:'inventory_difference',reason:null,turnoverDays:'10.05'})}];
  const view={warehouseCode:'A',warehouseName:'A',source:'live',snapshot:null,snapshots:[],rows,configured:true,robotConfigured:false,totalRows:1,goodsCount:1,page:1,pageSize:100,totalsByUnit:{Pcs:'100'},zeroCount:0,negativeCount:0,transitOnly:[{goodsNo:'ONLY-TRANSIT',goodsName:'在途商品',unitName:'Pcs',quantity:'80'}]} as InventoryView;
  const xml=new TextDecoder().decode(inventoryWorkbook(view,rows));
  assert.match(xml,/<c r="G2"[^>]*t="n"><v>50<\/v>/);assert.match(xml,/<c r="H2"[^>]*t="n"><v>452<\/v>/);
  const row=xml.match(/<row r="3">.*?ONLY-TRANSIT.*?<\/row>/)?.[0];assert.ok(row);assert.match(row,/<c r="G3"[^>]*><v>80<\/v>/);assert.doesNotMatch(row,/<c r="[CDH]3"/);
});


test('调拨筛选拒绝不符类型；旧采购单退出在途，旧调拨单继续跟踪',async()=>{
  const wrong=fixture();wrong.parent.inType='101';
  await assert.rejects(collectTransit('k','s','A',[],wrong.fetcher),/类型筛选/);
  const wrongDetail=fixture();wrongDetail.rows[0].inType='101';
  assert.ok((await collectTransit('k','s','A',[],wrongDetail.fetcher)).issues.some(x=>x.includes('不是调拨')));
  const before=await collectTransit('k','s','A',[],fixture().fetcher);
  const legacy=before.documents.map(({inType,...rest})=>rest);
  const purchase=fixture('3','0');purchase.parent.inType='101';purchase.rows[0].inType='101';
  const excluded=await collectTransit('k','s','A',legacy,purchase.fetcher);
  assert.equal(excluded.documents.length,0);assert.equal(excluded.issues.length,0);assert.equal(excluded.goods.length,0);
  assert.ok(purchase.calls.some(c=>c.inNo==='RK-old'&&!c.inType));
  const completed=await collectTransit('k','s','A',legacy,fixture('3','0').fetcher);
  assert.equal(completed.documents[0].inType,'102');assert.equal(completed.documents[0].state,'3');
});

test('旧全类型快照不作为当前调拨在途，历史仍可查看',async()=>{
  const db=sqlite();
  const legacy=await collectTransit('k','s','A',[],fixture().fetcher);delete legacy.scope;
  for(const doc of legacy.documents)delete doc.inType;
  db.prepare("INSERT INTO stock_snapshots (id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,coverage) VALUES('legacy','owner','2026-10-07','2026-10-07T00:00:00Z','complete',1,1,1,'{}',0,0,'A','auto:v1')").run();
  db.prepare('INSERT INTO transit_snapshots VALUES(?,?,?,?,?,?,?)').run('legacy','owner','A','2026-10-07T00:00:00Z','complete',JSON.stringify(legacy),null);
  const rows:InventoryView['rows']=[{goodsNo:'G0',goodsName:'g',unitName:'Pcs',quantity:'100',skuCount:1,history:{}}];
  enrichTransit('owner','A','legacy',rows);assert.equal(rows[0].transit?.quantity,null);assert.match(rows[0].transit?.reason||'',/重新采集/);
  assert.equal(transitOnlyGoods('owner','A','legacy').length,0);
  const history=loadTransitHistory('owner','A','2026-10-07');assert.equal(history.scope,undefined);assert.equal(history.goods[0].quantity,'1000');
});
