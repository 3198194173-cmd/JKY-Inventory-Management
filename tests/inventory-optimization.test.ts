import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { sqlite } from '../lib/sqlite.mjs';
import { addWarehouse, loadInventory } from '../lib/inventory-store';
import { reconcileWarehouseInbound } from '../lib/inbound-store';
import { addQuantity, multiplyQuantityByInteger } from '../lib/decimal';
import { previewTurnoverAlert, saveSettings, notifyAfterSnapshot } from '../lib/alerts-store';
import { sendManualAlert } from '../lib/manual-alerts';
import { robotScope } from '../lib/dingtalk-groups-store';
import { DingTalkCardError } from '../lib/dingtalk-cards';
import { sharedReportHash } from '../lib/shared-alert-deliveries';

mkdirSync('.sites-runtime/tests',{recursive:true});
Object.assign(process.env,{INVENTORY_DB_PATH:resolve('.sites-runtime/tests/optimization-'+randomUUID()+'.sqlite'),INVENTORY_DINGTALK_LOGIN_ENABLED:'false',DINGTALK_CLIENT_ID:'optimization-offline',DINGTALK_CLIENT_SECRET:'offline-test-only',DINGTALK_ROBOT_CODE:'optimization-offline'});
const db=sqlite();
function snapshot(owner:string,code:string,id:string,date:string,time='00:00:23'){
  db.prepare("INSERT INTO stock_snapshots(id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,coverage) VALUES(?,?,?,?,'complete',1,205,205,'{}',0,0,?,'auto:v1')").run(id,owner,date,date+'T'+time+'Z',code);
}
const entry=db.prepare('INSERT INTO stock_entries VALUES(?,?,?,?,?,1,?)');

test('均值、周转按未舍入值全仓排序后分页；缺失置尾，负值和筛选一致',async()=>{
  const owner='metric-order-owner',code='METRIC_SORT';await addWarehouse(owner,code,'排序仓库');
  for(let d=0;d<8;d++){
    const date='2026-10-0'+(d+1),id='sort-metric-'+d;snapshot(owner,code,id,date);db.prepare('INSERT INTO daily_slots VALUES(?,?,?,?)').run(owner,code,date,id);
    for(let i=0;i<205;i++){
      if(i===202&&d===3)continue;
      const rate=i===203?'1.001':i===204?'1.002':String(i),stock=i===201?'-1':'10000',value=addQuantity(stock,multiplyQuantityByInteger(rate,7-d));
      entry.run(id,'G'+String(i).padStart(3,'0'),'排序测试货品','件',value,value.startsWith('-')?-1:value==='0'?0:1);
    }
  }
  await reconcileWarehouseInbound(owner,code,'offline','offline',async()=>{},async()=>({quantity:'0',records:[]}));
  const read=(sort:string,extra:Record<string,unknown>={})=>loadInventory(owner,{warehouseCode:code,sort,pageSize:100,compact:true,...extra});
  const asc=await read('average_asc'),desc=await read('average_desc');
  assert.deepEqual(asc.rows.slice(0,4).map(r=>r.goodsNo),['G000','G001','G203','G204']);assert.deepEqual(desc.rows.slice(0,2).map(r=>r.goodsNo),['G201','G200']);
  assert.equal(asc.rows.find(r=>r.goodsNo==='G203')!.metrics!.average7,asc.rows.find(r=>r.goodsNo==='G204')!.metrics!.average7,'显示相同的舍入均值，排序仍按未舍入值');
  for(const sort of ['average_asc','average_desc','turnover_asc','turnover_desc']){
    const pages=await Promise.all([1,2,3].map(page=>read(sort,{page}))),all=pages.flatMap(p=>p.rows);
    assert.equal(all.length,205);assert.equal(new Set(all.map(r=>r.goodsNo)).size,205);assert.equal(all.at(-1)!.goodsNo,'G202');
    for(const days of [7,14,30])assert.deepEqual((await read(sort,{days})).rows.map(r=>r.goodsNo),pages[0].rows.map(r=>r.goodsNo));
  }
  assert.deepEqual((await read('turnover_asc')).rows.slice(0,2).map(r=>r.goodsNo),['G201','G200']);
  assert.deepEqual((await read('turnover_desc')).rows.slice(0,3).map(r=>r.goodsNo),['G001','G203','G204']);
  const filtered=await read('average_desc',{q:'G20'});assert.equal(filtered.totalRows,5);assert.deepEqual(filtered.rows.map(r=>r.goodsNo),['G201','G200','G204','G203','G202']);
  await addWarehouse('another-owner',code,'其他空间');assert.deepEqual((await loadInventory('another-owner',{warehouseCode:code,sort:'average_desc'})).rows,[]);
});

async function alertFixture(owner:string,code:string,group='shared-group'){
  await addWarehouse(owner,code,owner+'自己的仓库别名');
  for(let d=0;d<8;d++){
    const date='2026-10-0'+(d+1),id=owner+'-'+code+'-'+d;snapshot(owner,code,id,date,owner.endsWith('b')?'00:00:50':'00:00:23');
    db.prepare('INSERT INTO daily_slots VALUES(?,?,?,?)').run(owner,code,date,id);entry.run(id,'TEST-SKU','测试货品','件',String(100-d*4),1);
  }
  await reconcileWarehouseInbound(owner,code,'offline','offline',async()=>{},async()=>({quantity:'0',records:[]}));
  db.prepare('INSERT INTO dingtalk_groups(owner,client_id,robot_code,open_conversation_id,last_seen_at) VALUES(?,?,?,?,?)').run(...robotScope(owner),group,new Date().toISOString());
  await saveSettings(owner,true,'0','3',[group],undefined,{warehouseCode:code});
  const preview=await previewTurnoverAlert(owner,code);assert.equal(preview.count,1);
  return {requestId:randomUUID(),warehouseCode:code,snapshotId:preview.snapshotId,averageThreshold:'3',groupIds:[group]};
}
test('跨账户同仓同群按业务内容统一防重，手动与自动共享并发占位',async()=>{
  const code='GLOBAL_DEDUPE',a=await alertFixture('global-a',code),b=await alertFixture('global-b',code);
  const pa=await previewTurnoverAlert('global-a',code),pb=await previewTurnoverAlert('global-b',code);
  assert.notEqual(pa.snapshotId,pb.snapshotId);assert.notEqual(pa.capturedAt,pb.capturedAt);assert.equal(sharedReportHash(pa),sharedReportHash(pb));
  assert.equal(sharedReportHash({...pa,cards:pa.cards.map(c=>({...c,footer:'不同账户的另一组筛选阈值'}))}),sharedReportHash(pa),'筛选规则不同但最终商品和数据相同仍去重');
  let calls=0,release!:()=>void,entered!:()=>void;const hold=new Promise<void>(r=>release=r),start=new Promise<void>(r=>entered=r);
  const active=sendManualAlert('global-a',a,async()=>{calls++;entered();await hold;return 'accepted';});await start;
  try{const blocked=await sendManualAlert('global-b',b,async()=>{calls++;return 'unexpected';});assert.equal(blocked.groups[0].skipReason,'shared');assert.equal(blocked.groups[0].state,'skipped');}finally{release();await active;}
  await notifyAfterSnapshot('global-b',b.snapshotId,code,async()=>{calls++;return 'unexpected';});assert.equal(calls,1);
  db.prepare('UPDATE manual_alert_deliveries SET attempted_at=0').run();
  const repeat=await sendManualAlert('global-a',{...a,requestId:randomUUID()},async()=>{calls++;return 'unexpected';});assert.equal(repeat.groups[0].skipReason,'shared');assert.equal(calls,1);
  const c=await alertFixture('global-c',code,'other-group');await sendManualAlert('global-c',c,async()=>{calls++;return 'accepted';});assert.equal(calls,2,'不同接收群仍分别发送');
  const d=await alertFixture('global-d','ANOTHER_WAREHOUSE');await sendManualAlert('global-d',d,async()=>{calls++;return 'accepted';});assert.equal(calls,3,'不同仓库不互相阻挡');
  snapshot('global-b',code,'global-refresh','2026-10-08','01:00:00');entry.run('global-refresh','TEST-SKU','测试货品','件','71',1);
  db.prepare("UPDATE manual_alert_deliveries SET attempted_at=0 WHERE owner='global-b'").run();
  const changed=await sendManualAlert('global-b',{...b,requestId:randomUUID(),snapshotId:'global-refresh'},async()=>{calls++;return 'accepted';});assert.equal(changed.groups[0].state,'accepted');assert.equal(calls,4,'业务数据发生变化允许发送新报告');
  assert.notEqual(sharedReportHash({...pa,date:'2026-10-09'}),sharedReportHash(pa),'新的业务日期不复用旧报告');
});

test('不确定结果跨账户阻止重发，明确拒绝且未受理时可重新尝试',async()=>{
  for(const rejected of [false,true]){
    const code=rejected?'GLOBAL_REJECT':'GLOBAL_UNCERTAIN',oa=code+'a',ob=code+'b',a=await alertFixture(oa,code),b=await alertFixture(ob,code);
    let calls=0;const first=await sendManualAlert(oa,a,async()=>{calls++;if(rejected)throw new DingTalkCardError('钉钉明确拒绝',true);throw new Error('network interruption');});
    assert.equal(first.groups[0].state,rejected?'failed':'unconfirmed');
    const second=await sendManualAlert(ob,b,async()=>{calls++;return 'accepted';});assert.equal(second.groups[0].state,rejected?'accepted':'skipped');assert.equal(calls,rejected?2:1);
  }
});
