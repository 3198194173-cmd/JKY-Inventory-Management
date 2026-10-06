import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sqlite, localDatabase } from '../lib/sqlite.mjs';
import { enqueue, enqueueDaily } from '../lib/local-jobs';
import { acquireRun, addWarehouse, allRows, completeInventoryRun, loadInventory, publishSnapshot } from '../lib/inventory-store';
import { reconcileWarehouseInbound } from '../lib/inbound-store';
import type { InboundQuery, InboundRecord } from '../lib/inbound';
import { inventoryWorkbook } from '../lib/excel';
import { addQuantity, subtractQuantity, compareQuantity } from '../lib/decimal';
import { loadSalesCalendar } from '../lib/sales-calendar-store';
mkdirSync('.sites-runtime/tests',{recursive:true});
process.env.INVENTORY_DB_PATH=resolve(`.sites-runtime/tests/store-${Date.now()}.sqlite`);

test('负库存与无入库回补显示负净销量，不改写原始快照',async()=>{
  const db=sqlite(),owner='negative-owner',code='NEG01';await addWarehouse(owner,code,'负库存核算测试');
  for(const [date,values] of [['2026-10-02',['-4','58','-3']],['2026-10-03',['147','59','-4']]] as const){
    const id=`negative-${date}`;
    db.prepare("INSERT INTO stock_snapshots (id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,coverage) VALUES(?,?,?,?,'complete',1,3,3,'{}',0,1,?,'auto:v1')").run(id,owner,date,date+'T00:00:23.000Z',code);
    db.prepare('INSERT INTO daily_slots VALUES(?,?,?,?)').run(owner,code,date,id);
    for(let i=0;i<3;i++)db.prepare('INSERT INTO stock_entries (snapshot_id,goods_no,goods_name,unit_name,quantity,sku_count,sign) VALUES (?,?,?,\'Pcs\',?,1,?)').run(id,['NEGATIVE','NO-INBOUND','VALID-NEGATIVE'][i],'测试货品',values[i],compareQuantity(values[i],'0'));
  }
  await reconcileWarehouseInbound(owner,code,'k','s',async()=>{},async()=>({quantity:'0',records:[{recId:'negative-inbound',docId:'negative-doc',documentNo:'TEST-150',goodsNo:'NEGATIVE',warehouseCode:code,skuBarcode:'NEGATIVE',quantity:'150',unitName:'Pcs',inOutDate:'2026-10-02T06:29:03.000Z',createdAt:null,typeName:'调拨入库'}]}));
  const calendar=await loadSalesCalendar(owner,code,'NEGATIVE','2026-10'),day=calendar.days[1];
  assert.equal(day.sales,'-1');assert.equal(day.correction!.correctedQuantity,'-1');
  assert.equal(day.correction!.error,null);assert.equal(day.correction!.status,'verified');
  const noInbound=(await loadSalesCalendar(owner,code,'NO-INBOUND','2026-10')).days[1];
  assert.equal(noInbound.sales,'-1');assert.equal(noInbound.correction!.error,null);
  assert.equal((await loadSalesCalendar(owner,code,'VALID-NEGATIVE','2026-10')).days[1].sales,'1');
  const view=await loadInventory(owner,{warehouseCode:code});
  assert.equal(view.rows.find(r=>r.goodsNo==='NEGATIVE')!.metrics!.average7,null);
  assert.equal(db.prepare("SELECT quantity FROM stock_entries WHERE snapshot_id='negative-2026-10-02' AND goods_no='NEGATIVE'").get()!.quantity,'-4');
  assert.equal(db.prepare("SELECT error FROM inbound_reconciliations WHERE owner=? AND goods_no='NEGATIVE'").get(owner)!.error,null,'负净销量是已完成核验的结果');
  assert.match(new TextDecoder().decode(inventoryWorkbook(view,view.rows)),/原始差额 -151 \| 入库 150 \| 修正 -1/);
});

test('主表/月历/导出共同使用负净销量及带符号7天均值',async()=>{
  const db=sqlite(),owner='negative-owner',code='NET01';await addWarehouse(owner,code,'净销量均值测试');
  const stocks={MIXED:['100','90','92','87','87','86','84','85'],RETURNS:['100','100','102','102','102','102','102','102'],ZERO:['100','98','100','100','100','100','100','100']};
  for(let i=0;i<8;i++){
    const date='2026-10-0'+(i+1),id='net-'+date;
    db.prepare("INSERT INTO stock_snapshots (id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,coverage) VALUES(?,?,?,?,'complete',1,3,3,'{}',0,0,?,'auto:v1')").run(id,owner,date,date+'T00:00:23Z',code);
    db.prepare('INSERT INTO daily_slots VALUES(?,?,?,?)').run(owner,code,date,id);
    for(const [goods,values] of Object.entries(stocks))db.prepare("INSERT INTO stock_entries VALUES(?,?,?,'Pcs',?,1,1)").run(id,goods,goods==='RETURNS'?'退货回补样本':goods==='MIXED'?'正负销量混合样本':'净消耗为零样本',values[i]);
  }
  await reconcileWarehouseInbound(owner,code,'k','s',async()=>{},async()=>({quantity:'0',records:[]}));
  const view=await loadInventory(owner,{warehouseCode:code});
  const mixed=view.rows.find(r=>r.goodsNo==='MIXED')!,returned=view.rows.find(r=>r.goodsNo==='RETURNS')!,zero=view.rows.find(r=>r.goodsNo==='ZERO')!;
  assert.equal(mixed.metrics!.average7,'2.14');assert.equal(mixed.metrics!.turnoverDays,'39.67');assert.equal(mixed.sales!['2026-10-02'],'-2');
  assert.equal(returned.metrics!.average7,'-0.29');assert.equal(returned.metrics!.turnoverDays,null);assert.equal(returned.metrics!.validDays,7);
  assert.equal(zero.metrics!.average7,'0');assert.equal(zero.metrics!.turnoverDays,null);
  assert.equal((await loadSalesCalendar(owner,code,'RETURNS','2026-10')).days[1].sales,'-2');
  const xml=new TextDecoder().decode(inventoryWorkbook(view,view.rows));
  assert.match(xml,/近7天销量均值（估算）/);assert.match(xml,/<v>-0.29<\/v>/);assert.match(xml,/修正 -2/);
});

test('升级旧负净销量仅恢复完整全仓查询，失败/冲销/旧口径仍待核验且可重复执行',async()=>{
  const db=sqlite(),owner='negative-owner',code='NEG01';
  const oldError='入库冲销或其他库存变动尚未解释，仍需核对';
  const cases=[
    ['LEGACY-RETURN','unresolved','0','-1','warehouse:v1',oldError,'verified'],
    ['LEGACY-RECEIPT','unresolved','150','-1','warehouse:v1',oldError,'verified'],
    ['FAILED','failed',null,null,'warehouse:v1','分页失败','failed'],
    ['REVERSAL','unresolved','-2','-3','warehouse:v1',oldError,'unresolved'],
    ['OLD-SCOPE','unresolved','0','-1','goods:v1',oldError,'unresolved'],
    ['OTHER-PENDING','unresolved','0','-1','warehouse:v1','其他错误','unresolved'],
    ['POSITIVE-PENDING','unresolved','0','1','warehouse:v1',oldError,'unresolved'],
  ];
  for(const [goods,status,inbound,corrected,scope,error] of cases) {
    const raw=inbound!=null && corrected!=null ? subtractQuantity(corrected,inbound) : '-1';
    db.prepare("INSERT INTO inbound_reconciliations (owner,warehouse_code,goods_no,date,before_snapshot_id,after_snapshot_id,unit_name,raw_difference,opening_quantity,closing_quantity,status,inbound_quantity,corrected_quantity,window_start,window_end,error,checked_at,query_scope) VALUES(?,?,?,'2026-10-02','negative-2026-10-02','negative-2026-10-03','Pcs',?,?,'59',?,?,?,'2026-10-02T00:00:23Z','2026-10-03T00:00:23Z',?,'old',?)").run(owner,code,goods,raw,addQuantity('59',raw),status,inbound,corrected,error,scope);
  }
  const migration=readFileSync('drizzle/0007_net_sales_returns.sql','utf8');
  for(let run=0;run<2;run++) {
    db.exec(migration);
    for(const [goods,,inbound,corrected,,,status] of cases) {
      // Expected status is the last item; source numbers and timestamps stay intact.
      const row=db.prepare('SELECT * FROM inbound_reconciliations WHERE owner=? AND goods_no=?').get(owner,goods)!;
      assert.equal(row.status,status);assert.equal(row.corrected_quantity,corrected);assert.equal(row.raw_difference,inbound!=null && corrected!=null ? subtractQuantity(corrected,inbound) : '-1');assert.equal(row.checked_at,'old');
      if(status==='verified')assert.equal(row.error,null);
    }
  }
});

test('销量月历读取历史月份、月末闭合基准及用户隔离，不跨缺日计算',async()=>{
  const db=sqlite(),owner='calendar-owner',code='CAL01';await addWarehouse(owner,code,'月历测试仓');
  const snapshot=db.prepare("INSERT INTO stock_snapshots (id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,coverage) VALUES(?,?,?,?,'complete',1,1,1,'{}',0,0,?,'auto:v1')");
  for(const [date,value,unit] of [['2026-09-30','30','Pcs'],['2026-10-01','28','Pcs'],['2026-10-02','527','Pcs'],['2026-10-04','512','Pcs'],['2026-10-05','512','箱'],['2026-10-31','40','Pcs'],['2026-11-01','35','Pcs'],['2026-12-01','99','Pcs']]) {
    const id='calendar-'+date;snapshot.run(id,owner,date,date+'T00:00:23Z',code);
    db.prepare('INSERT INTO daily_slots VALUES(?,?,?,?)').run(owner,code,date,id);
    db.prepare('INSERT INTO stock_entries VALUES(?,?,?,?,?,1,1)').run(id,'CAL-GOODS','历史货品',unit,value);
  }
  snapshot.run('calendar-manual',owner,'2026-10-31','2026-10-31T10:00:00Z',code);
  db.prepare("INSERT INTO stock_entries VALUES('calendar-manual','CAL-GOODS','历史货品','Pcs','999',1,1)").run();
  for(const [date,next,opening,closing,inbound,sales] of [['2026-09-30','2026-10-01','30','28','0','2'],['2026-10-01','2026-10-02','28','527','500','1'],['2026-10-31','2026-11-01','40','35','0','5']]) {
    db.prepare("INSERT INTO inbound_reconciliations (owner,warehouse_code,goods_no,date,before_snapshot_id,after_snapshot_id,unit_name,raw_difference,opening_quantity,closing_quantity,status,inbound_quantity,corrected_quantity,window_start,window_end,checked_at,query_scope) VALUES(?,?,'CAL-GOODS',?,?,?,'Pcs',?,?,?,'verified',?,?,?,?,?,'warehouse:v1')")
      .run(owner,code,date,'calendar-'+date,'calendar-'+next,date==='2026-10-01'?'-499':sales,opening,closing,inbound,sales,date+'T00:00:23Z',next+'T00:00:23Z',next+'T00:00:23Z');
  }
  assert.equal((await loadInventory(owner,{warehouseCode:code})).salesDates!.includes('2026-10-01'),false,'主表只展示近期');
  const october=await loadSalesCalendar(owner,code,'CAL-GOODS','2026-10');
  assert.equal(october.days.length,31);assert.equal(october.firstMonth,'2026-09');assert.equal(october.lastMonth,'2026-12');
  assert.equal(october.days[0].sales,'1');assert.equal(october.days[0].correction!.inboundQuantity,'500');
  assert.equal(october.days[30].sales,'5');assert.equal(october.days[30].closingQuantity,'35');assert.equal(october.days[30].openingQuantity,'40','手动库存不替代固定基准');
  assert.equal(october.days[1].sales,null,'缺10月3日不能跨日扣减');assert.equal(october.days[1].closingQuantity,null);
  assert.equal(october.days[3].sales,null,'单位变化不强行计算');
  assert.equal((await loadSalesCalendar(owner,code,'CAL-GOODS','2026-09')).days[29].sales,'2','月末使用下一月首日');
  assert.equal((await loadSalesCalendar(owner,code,'CAL-GOODS','2028-02')).days.length,29,'闰年月历');
  assert.equal((await loadSalesCalendar(owner,code,'MISSING','2026-10')).days.every(d=>d.sales===null && !d.correction),true);
  await assert.rejects(()=>loadSalesCalendar('other-owner',code,'CAL-GOODS','2026-10'),/先增加/);
  await addWarehouse('other-owner',code,'其他用户仓');assert.equal((await loadSalesCalendar('other-owner',code,'CAL-GOODS','2026-10')).days.every(d=>d.openingQuantity===null && !d.correction),true);
  await assert.rejects(()=>loadSalesCalendar(owner,code,'CAL-GOODS','2026-13'),/有效月份/);
  await assert.rejects(()=>loadSalesCalendar(owner,code,'CAL-GOODS',"2026-10' OR 1=1"),/有效月份/);
});

test('本地数据库迁移、事务回滚、队列去重与多仓库快照隔离',async()=>{
  const db=sqlite();
  assert.equal(db.prepare('SELECT count(*) AS n FROM local_migrations').get()!.n,8);
  await addWarehouse('test-owner','TEST01','测试仓');
  const first=enqueue('test-owner','TEST01'),second=enqueue('test-owner','TEST01');
  assert.equal(first.id,second.id);
  const run=await acquireRun('test-owner','TEST01','manual',first.id);
  await assert.rejects(()=>acquireRun('test-owner','TEST01'),/正在进行/);
  await publishSnapshot('test-owner',run,[{goodsNo:'A',goodsName:'测试',unitName:'Pcs',quantity:'12345678901234567890.123',skuCount:1}],1,1,0,{key:'auto:v1',label:'测试仓',count:1},{code:'TEST01',name:'测试仓',id:'1',hash:'test'},[]);
  const view=await loadInventory('test-owner',{warehouseCode:'TEST01'});
  assert.equal(view.rows[0].quantity,'12345678901234567890.123');
  assert.equal((await loadInventory('other-owner')).totalRows,0);
  await assert.rejects(()=>localDatabase.batch([
    localDatabase.prepare("UPDATE warehouses SET name='错误' WHERE owner='test-owner' AND code='TEST01'"),
    localDatabase.prepare('INSERT INTO nonexistent_table VALUES(1)')
  ]));
  assert.equal(db.prepare("SELECT name FROM warehouses WHERE owner='test-owner' AND code='TEST01'").get()!.name,'测试仓');
});

test('仓库分页结果覆盖库存下降、持平、增加；重试与手动区间隔离',async()=>{
  const db=sqlite(),owner='inbound-owner',code='INBOUND01';
  await addWarehouse(owner,code,'入库测试仓');
  const snapshot=db.prepare("INSERT INTO stock_snapshots (id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,coverage) VALUES (?,?,?,?,'complete',1,5,5,'{}',0,0,?,'auto:v1')");
  const entry=db.prepare('INSERT INTO stock_entries (snapshot_id,goods_no,goods_name,unit_name,quantity,sku_count,sign) VALUES (?, ?, ?, ?, ?, 1, 1)');
  for(let day=1;day<=8;day++) {
    const date=`2026-10-0${day}`,id=`inbound-day-${day}`;
    snapshot.run(id,owner,date,`${date}T00:00:23.000Z`,code);
    db.prepare('INSERT INTO daily_slots VALUES(?,?,?,?)').run(owner,code,date,id);
    entry.run(id,'A','真实入库修正','Pcs',String(day<=2 ? 28 : day===3 ? 527 : 512));
    entry.run(id,'B','无法解释增加','Pcs',day<=2 ? '1' : '5');
    entry.run(id,'C','单位错误','Pcs',day<=2 ? '1' : '4');
    entry.run(id,'D','库存下降也有入库','Pcs',day<=2 ? '28' : '27');
    entry.run(id,'E','持平也有入库','Pcs','20');
  }
  let badUnit=true;
  const queries:InboundQuery[]=[];
  const collector=async(_key:string,_secret:string,q:InboundQuery)=>{
    queries.push(q);assert.equal(q.goodsNo,undefined);assert.equal(q.unitName,undefined);
    const quantities=q.end.includes('T01:') ? {A:'12'} : q.start.startsWith('2026-10-08') ? {A:q.start.includes('T01:')?'3':'15'} : q.start.startsWith('2026-10-02') ? {A:'500',C:'3',D:'10',E:'5'} : {};
    const records:InboundRecord[]=Object.entries(quantities).map(([goodsNo,quantity])=>({recId:goodsNo+q.end,docId:'1038047',documentNo:'CRK202610022053',goodsNo,warehouseCode:code,skuBarcode:goodsNo,quantity,unitName:goodsNo==='C' && badUnit ? '箱' : 'Pcs',inOutDate:new Date(Date.parse(q.end)-1000).toISOString(),createdAt:null,typeName:'调拨入库'}));
    return {quantity:'0',records};
  };
  const first=await reconcileWarehouseInbound(owner,code,'k','s',async()=>{},collector);
  assert.deepEqual(first,{checked:35,windows:7,verified:34,unresolved:0,failed:1});
  assert.equal(queries.length,7,'5商品×7天仅查询7个仓库区间');
  let view=await loadInventory(owner,{warehouseCode:code});
  const a=view.rows.find(r=>r.goodsNo==='A')!,b=view.rows.find(r=>r.goodsNo==='B')!,c=view.rows.find(r=>r.goodsNo==='C')!;
  assert.equal(a.rawSales!['2026-10-02'],'-499');assert.equal(a.sales!['2026-10-02'],'1');
  assert.equal(a.metrics!.average7,'2.29');assert.equal(a.metrics!.turnoverDays,'224');
  assert.equal(a.inbound!['2026-10-02'].records[0].quantity,'500');
  assert.equal(view.rows.find(r=>r.goodsNo==='D')!.sales!['2026-10-02'],'11');
  assert.equal(view.rows.find(r=>r.goodsNo==='E')!.sales!['2026-10-02'],'5');
  assert.equal(b.sales!['2026-10-02'],'-4');assert.equal(b.inbound!['2026-10-02'].status,'verified');
  assert.equal(b.metrics!.average7,'-0.57');assert.equal(b.metrics!.reason,'net_returns');assert.equal(b.metrics!.turnoverDays,null);
  assert.equal(c.sales!['2026-10-02'],null);assert.equal(c.inbound!['2026-10-02'].inboundQuantity,null);
  const verifiedAt=a.inbound!['2026-10-02'].checkedAt;
  assert.equal(db.prepare("SELECT quantity FROM stock_entries WHERE snapshot_id='inbound-day-3' AND goods_no='A'").get()!.quantity,'527');
  snapshot.run('inbound-manual',owner,'2026-10-08','2026-10-08T01:00:00Z',code);
  for(const row of view.rows)entry.run('inbound-manual',row.goodsNo,row.goodsName,row.unitName,row.goodsNo==='A'?'523':row.quantity);
  badUnit=false;
  const second=await reconcileWarehouseInbound(owner,code,'k','s',async()=>{},collector,'inbound-manual');
  assert.deepEqual(second,{checked:6,windows:2,verified:6,unresolved:0,failed:0});
  view=await loadInventory(owner,{warehouseCode:code});
  const manual=view.rows.find(r=>r.goodsNo==='A')!;
  assert.equal(manual.inbound!['2026-10-02'].checkedAt,verifiedAt,'成功货品区间复用');
  assert.equal(manual.currentInbound!.inboundQuantity,'12');assert.equal(manual.currentInbound!.correctedQuantity,'1');
  assert.equal(manual.sales!['2026-10-02'],'1');assert.equal(manual.metrics!.average7,'2.29');assert.equal(manual.metrics!.turnoverDays,'228.81');
  assert.equal(view.rows.find(r=>r.goodsNo==='C')!.sales!['2026-10-02'],'0');
  assert.equal((await loadInventory('another-owner')).rows.length,0);
  const full=await allRows(owner,code),xml=new TextDecoder().decode(inventoryWorkbook(full.view,full.rows));
  assert.ok(xml.includes('CRK202610022053'));assert.ok(xml.includes('原始差额 -499 | 入库 500 | 修正 1'));
  snapshot.run('inbound-day-9',owner,'2026-10-09','2026-10-09T00:00:23.000Z',code);
  db.prepare('INSERT INTO daily_slots VALUES(?,?,?,?)').run(owner,code,'2026-10-09','inbound-day-9');
  for(const row of view.rows)entry.run('inbound-day-9',row.goodsNo,row.goodsName,row.unitName,row.goodsNo==='A'?'520':row.quantity);
  await reconcileWarehouseInbound(owner,code,'k','s',async()=>{},collector,'inbound-day-9');
  const next=(await loadInventory(owner,{warehouseCode:code})).rows.find(r=>r.goodsNo==='A')!;
  assert.equal(next.sales!['2026-10-08'],'7','固定每日区间512+15-520');
  assert.equal(next.currentInbound!.correctedQuantity,'6','上次手动采集区间523+3-520独立显示');
  assert.equal(next.currentInbound!.windowStart,'2026-10-08T01:00:00Z');
});

test('库存保存后仍保留运行锁，入库核验结束才报告采集完成',async()=>{
  const owner='lock-owner',code='LOCK01';await addWarehouse(owner,code,'锁测试');
  const id=await acquireRun(owner,code);
  await publishSnapshot(owner,id,[{goodsNo:'LOCK',goodsName:'测试',unitName:'Pcs',quantity:'10',skuCount:1}],1,1,0,{key:'auto:v1',label:'测试',count:1},{code,name:'测试',id:'1',hash:'lock'},[],true);
  assert.equal((await loadInventory(owner,{warehouseCode:code})).rows[0].quantity,'10');
  assert.equal(sqlite().prepare('SELECT status FROM sync_runs WHERE id=?').get(id)!.status,'running');
  await assert.rejects(acquireRun(owner,code),/正在进行/);
  await completeInventoryRun(id,'库存已保存；入库核验完成');
  assert.equal(sqlite().prepare('SELECT status FROM sync_runs WHERE id=?').get(id)!.status,'complete');
});
test('08:00定时边界、重试上限与已有每日基准去重',async()=>{
  const db=sqlite();await addWarehouse('daily-owner','DAILY01','定时测试');
  const count=()=>Number(db.prepare("SELECT count(*) AS n FROM local_jobs WHERE owner='daily-owner' AND warehouse_code='DAILY01'").get()!.n);
  enqueueDaily('2030-01-01 07:59:59');assert.equal(count(),0);
  enqueueDaily('2030-01-01 08:00:00');assert.equal(count(),1);
  enqueueDaily('2030-01-01 08:01:00');assert.equal(count(),1);
  for(let i=0;i<4;i++){
    db.prepare("UPDATE local_jobs SET state='failed',updated_at='2000-01-01T00:00:00Z' WHERE owner='daily-owner' AND warehouse_code='DAILY01'").run();
    enqueueDaily('2030-01-01 08:10:00');
  }
  assert.equal(count(),3);
  const snapshot=db.prepare("SELECT id FROM stock_snapshots LIMIT 1").get()!.id;
  db.prepare("INSERT INTO daily_slots VALUES('daily-owner','DAILY01','2030-01-02',?)").run(snapshot);
  enqueueDaily('2030-01-02 08:00:00');assert.equal(count(),3);
});

test('7天指标不随展示范围变化，手动刷新只更新周转分子，全量导出覆盖第二页',async()=>{
  const db=sqlite(),owner='metrics-owner',code='METRIC01';
  await addWarehouse(owner,code,'指标测试仓');
  const snapshot=db.prepare("INSERT INTO stock_snapshots (id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,coverage) VALUES (?,?,?,?,'complete',1,101,101,'{}',0,0,?,'auto:v1')");
  const entry=db.prepare('INSERT INTO stock_entries (snapshot_id,goods_no,goods_name,unit_name,quantity,sku_count,sign) VALUES (?, ?, ?, ?, ?, 1, 1)');
  for(let day=1;day<=8;day++) {
    const date=`2030-04-0${day}`,id=`metric-day-${day}`;
    snapshot.run(id,owner,date,`${date}T00:00:00Z`,code);
    db.prepare('INSERT INTO daily_slots VALUES(?,?,?,?)').run(owner,code,date,id);
    for(let i=0;i<101;i++) entry.run(id,`M${String(i).padStart(3,'0')}`,'测试货品','Pcs',String(100-(day-1)*2));
  }
  snapshot.run('metric-manual',owner,'2030-04-08','2030-04-08T01:00:00Z',code);
  for(let i=0;i<101;i++) entry.run('metric-manual',`M${String(i).padStart(3,'0')}`,'测试货品','Pcs','70');
  await reconcileWarehouseInbound(owner,code,'k','s',async()=>{},async()=>({quantity:'0',records:[]}),'metric-manual');
  for (const days of [7,14,30]) {
    const view=await loadInventory(owner,{warehouseCode:code,days,page:2,pageSize:100});
    assert.equal(view.rows.length,1);
    assert.equal(view.rows[0].metrics!.average7,'2'); assert.equal(view.rows[0].metrics!.turnoverDays,'35');
    assert.equal(view.rows[0].sales!['2030-04-07'],'2');
    assert.equal(view.rows[0].quantity,'70');
  }
  const full=await allRows(owner,code);
  assert.equal(full.rows.length,101); assert.equal(full.rows[100].metrics!.turnoverDays,'35');
  const xml=new TextDecoder().decode(inventoryWorkbook(full.view,full.rows));
  assert.ok(xml.includes('库存周转（天·估算）')); assert.ok(xml.includes('2030-04-01 ~ 2030-04-07'));
  assert.ok(xml.includes('r="D102"')); assert.ok(!xml.includes('r="I102"'));
});


test('6000货品仅查一个仓库区间，整页查询失败不补零，旧核验升级且成功后复用',async()=>{
  const db=sqlite(),owner='batch-owner',code='BATCH01';await addWarehouse(owner,code,'大仓测试');
  const snapshot=db.prepare("INSERT INTO stock_snapshots (id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,coverage) VALUES (?,?,?,?,'complete',1,6000,6000,'{}',0,0,?,'auto:v1')");
  for(const [id,date,quantity] of [['batch-before','2026-10-01','10'],['batch-after','2026-10-02','8']]) {
    snapshot.run(id,owner,date,date+'T00:00:00Z',code);db.prepare('INSERT INTO daily_slots VALUES(?,?,?,?)').run(owner,code,date,id);
    const entries=Array.from({length:6000},(_,i)=>['M'+String(i).padStart(5,'0'),'测试','Pcs',quantity,1,1]);
    db.prepare("INSERT INTO stock_entries SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),json_extract(value,'$[4]'),json_extract(value,'$[5]') FROM json_each(?)").run(id,JSON.stringify(entries));
  }
  db.prepare("INSERT INTO inbound_reconciliations (owner,warehouse_code,goods_no,date,before_snapshot_id,after_snapshot_id,unit_name,raw_difference,opening_quantity,closing_quantity,status,inbound_quantity,corrected_quantity,window_start,window_end,checked_at) VALUES(?,?,'M00000','2026-10-01','batch-before','batch-after','Pcs','2','10','8','verified','0','2','2026-10-01T00:00:00Z','2026-10-02T00:00:00Z','old')").run(owner,code);
  assert.equal((await loadInventory(owner,{warehouseCode:code})).rows[0].sales!['2026-10-01'],null,'旧版单货品核验不冒充全仓核验');
  let calls=0;
  const failure=await reconcileWarehouseInbound(owner,code,'k','s',async()=>{},async()=>{calls++;throw Error('分页失败');},'batch-after');
  assert.deepEqual(failure,{checked:6000,windows:1,verified:0,unresolved:0,failed:6000});assert.equal(calls,1);
  let view=await loadInventory(owner,{warehouseCode:code});assert.equal(view.rows[0].quantity,'8');assert.equal(view.rows[0].sales!['2026-10-01'],null);assert.equal(view.rows[0].inbound!['2026-10-01'].inboundQuantity,null);
  const collector=async(_key:string,_secret:string,q:InboundQuery)=>{calls++;assert.equal(q.goodsNo,undefined);return {quantity:'5',records:[{recId:'batch-in',docId:'batch-doc',documentNo:'BATCH-IN',goodsNo:'M00000',warehouseCode:code,skuBarcode:'M00000',quantity:'5',unitName:'Pcs',inOutDate:'2026-10-01T10:00:00Z',createdAt:null,typeName:'入库'}]};};
  const success=await reconcileWarehouseInbound(owner,code,'k','s',async()=>{},collector,'batch-after');assert.deepEqual(success,{checked:6000,windows:1,verified:6000,unresolved:0,failed:0});assert.equal(calls,2);
  view=await loadInventory(owner,{warehouseCode:code});assert.equal(view.rows.find(r=>r.goodsNo==='M00000')!.sales!['2026-10-01'],'7');assert.equal(view.rows.find(r=>r.goodsNo==='M00001')!.sales!['2026-10-01'],'2');
  assert.deepEqual(await reconcileWarehouseInbound(owner,code,'k','s',async()=>{},collector,'batch-after'),{checked:0,windows:0,verified:0,unresolved:0,failed:0});assert.equal(calls,2);
});


test('逐日期销量全仓精确排序后分页，入库修正/并列/未核验/筛选/不同日期互不混淆',async()=>{
  const db=sqlite(),owner='sales-sort-owner',code='SORT01';await addWarehouse(owner,code,'排序测试仓');
  const snapshots=['sort-day-1','sort-day-2','sort-day-3'];
  for(let d=0;d<3;d++) {
    const date='2026-10-0'+(d+1);
    db.prepare("INSERT INTO stock_snapshots (id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,coverage) VALUES(?,?,?,?,'complete',1,205,205,'{}',0,0,?,'auto:v1')").run(snapshots[d],owner,date,date+'T00:00:00Z',code);
    db.prepare('INSERT INTO daily_slots VALUES(?,?,?,?)').run(owner,code,date,snapshots[d]);
  }
  const expected:Record<string,string|null>={};
  for(let i=0;i<205;i++) {
    const goods='G'+String(i).padStart(3,'0');
    const first=i===1?'9007199254740990.1':i===2?'9007199254740990.2':i===3?'10.02':i===4?'10.1':i>=5 && i<=13?['-100','-2','-0.5','-0.01','-9007199254740990.2','-9007199254740990.1','-10.1','-10.02','-2'][i-5]:i>=203?'5':String(i%30);
    const second=String(205-i);
    expected[goods]=i>=203?null:i===0?'1000':first;
    const quantities=[addQuantity(addQuantity('100',second),first),addQuantity('100',second),'100'];
    for(let d=0;d<3;d++)db.prepare('INSERT INTO stock_entries VALUES(?,?,?,?,?,1,1)').run(snapshots[d],goods,goods,'Pcs',quantities[d]);
  }
  await reconcileWarehouseInbound(owner,code,'k','s',async()=>{},async(_k,_s,q)=>({quantity:'1000',records:q.start.startsWith('2026-10-01')?[{recId:'sort-receipt',docId:'sort-doc',documentNo:'SORT-INBOUND',goodsNo:'G000',warehouseCode:code,skuBarcode:'G000',quantity:'1000',unitName:'Pcs',inOutDate:'2026-10-01T12:00:00Z',createdAt:null,typeName:'入库'}]:[]}));
  db.prepare("UPDATE inbound_reconciliations SET status='failed',inbound_quantity=NULL,corrected_quantity=NULL WHERE owner=? AND goods_no='G203' AND date='2026-10-01'").run(owner);
  db.prepare("DELETE FROM inbound_reconciliations WHERE owner=? AND goods_no='G204' AND date='2026-10-01'").run(owner);
  for(const ascending of [true,false]) {
    const expectedOrder=Object.keys(expected).sort((a,b)=>expected[a]==null?(expected[b]==null?a.localeCompare(b):1):expected[b]==null?-1:compareQuantity(expected[a]!,expected[b]!)*(ascending?1:-1)||a.localeCompare(b));
    const actual:string[]=[];
    for(let page=1;page<=3;page++) {
      const view=await loadInventory(owner,{warehouseCode:code,sort:ascending?'sales_asc':'sales_desc',sortDate:'2026-10-01',page,pageSize:100});
      assert.equal(view.totalRows,205);actual.push(...view.rows.map(r=>r.goodsNo));
      for(const row of view.rows)assert.equal(row.sales!['2026-10-01'],expected[row.goodsNo]);
    }
    assert.deepEqual(actual,expectedOrder,'整仓排序先于分页，空值末尾且并列编码稳定');
  }
  const other=await loadInventory(owner,{warehouseCode:code,sort:'sales_desc',sortDate:'2026-10-02'});
  assert.equal(other.rows[0].goodsNo,'G000');assert.equal(other.rows[0].sales!['2026-10-02'],'205');
  const filtered=await loadInventory(owner,{warehouseCode:code,q:'G00',sort:'sales_desc',sortDate:'2026-10-01'});
  assert.deepEqual(filtered.rows.slice(0,3).map(r=>r.goodsNo),['G002','G001','G000']);
  const invalid=await loadInventory(owner,{warehouseCode:code,sort:'sales_desc',sortDate:"2026-10-01' OR 1=1--"});
  assert.equal(invalid.rows[0].goodsNo,'G000','无效日期回退编码排序');
  assert.equal((await loadInventory('different-owner',{warehouseCode:'CK031',sort:'sales_desc',sortDate:'2026-10-01'})).rows.length,0);
});
