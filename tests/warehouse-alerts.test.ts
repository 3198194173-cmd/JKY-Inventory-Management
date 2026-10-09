import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sqlite } from '../lib/sqlite.mjs';
import { addWarehouse,allRows } from '../lib/inventory-store';
import { reconcileWarehouseInbound } from '../lib/inbound-store';
import { settings,saveSettings,saveCollectionSchedule,previewTurnoverAlert } from '../lib/alerts-store';
import { robotScope } from '../lib/dingtalk-groups-store';
import { turnoverAlert,normalizeExcludedNames,normalizeTurnoverDays } from '../lib/turnover-alert';
import { attachReportExport,readReportExport,reportExportBaseUrl } from '../lib/alert-report-export';
import { alertWorkbook } from '../lib/excel';
import { sendManualAlert } from '../lib/manual-alerts';
import { sendDueAlerts } from '../lib/scheduled-alerts';
import { enqueueDaily } from '../lib/local-jobs';

mkdirSync('.sites-runtime/tests',{recursive:true});
process.env.INVENTORY_DB_PATH=resolve(`.sites-runtime/tests/warehouse-rules-${Date.now()}.sqlite`);

test('升级继承每个已有仓库的全局规则和群，新增仓库独立关闭',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE warehouses(owner,code); CREATE TABLE alert_settings(owner,enabled,threshold,turnover_average_threshold,notify_time);
      CREATE TABLE dingtalk_groups(owner,client_id,robot_code,open_conversation_id,enabled,active);
      CREATE TABLE manual_alert_deliveries(id); CREATE TABLE turnover_group_deliveries(id);
      INSERT INTO warehouses VALUES('owner','A'),('owner','B'),('other','A');
      INSERT INTO alert_settings VALUES('owner',1,'0','4.5','10:20');
      INSERT INTO dingtalk_groups VALUES('owner','app','bot','group',1,1),('owner','app','bot','removed',1,0);`);
    db.exec(readFileSync('drizzle/0014_warehouse_alert_settings.sql','utf8'));
    for(const code of ['A','B']){
      const row=db.prepare('SELECT * FROM warehouse_alert_settings WHERE owner=? AND warehouse_code=?').get('owner',code)!;
      assert.equal(row.enabled,1);assert.equal(row.turnover_average_threshold,'4.5');assert.equal(row.turnover_days,'30');assert.equal(row.notify_time,'10:20');
      assert.equal(db.prepare('SELECT count(*) AS n FROM warehouse_alert_groups WHERE owner=? AND warehouse_code=?').get('owner',code)!.n,1);
    }
    db.exec("INSERT INTO warehouses VALUES('owner','C')");
    assert.equal(db.prepare("SELECT enabled FROM warehouse_alert_settings WHERE owner='owner' AND warehouse_code='C'").get()!.enabled,0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM warehouse_alert_groups WHERE owner='other'").get()!.n,0);
  } finally {db.close();}
});

test('每仓独立规则、接收群和两种时间；名称只排除通知，规则实时改变候选商品',async()=>{
  const names=['DINGTALK_CLIENT_ID','DINGTALK_CLIENT_SECRET','DINGTALK_ROBOT_CODE'],old=names.map(n=>process.env[n]);
  names.forEach(n=>process.env[n]='warehouse-test-only');
  const owner='per-warehouse',db=sqlite();
  try {
    for(const code of ['A','B']){
      await addWarehouse(owner,code,code+'仓');
      for(let i=0;i<8;i++){
        const date=`2026-10-0${i+1}`,id=`${code}-${date}`;
        db.prepare("INSERT INTO stock_snapshots (id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,coverage) VALUES(?,?,?,?,'complete',1,3,3,'{}',0,0,?,'auto:v1')").run(id,owner,date,date+'T00:00:23Z',code);
        db.prepare('INSERT INTO daily_slots VALUES(?,?,?,?)').run(owner,code,date,id);
        for(const [goodsNo,goodsName,quantity] of [['MAGNET','CASEBANG 磁吸背盖',String(20-4*i)],['CASE','透明手机壳',String(100-4*i)],['SLOW','慢销手机壳',String(100-2*i)]])
          db.prepare('INSERT INTO stock_entries VALUES(?,?,?,?,?,1,1)').run(id,goodsNo,goodsName,'Pcs',quantity);
      }
      await reconcileWarehouseInbound(owner,code,'k','s',async()=>{},async()=>({quantity:'0',records:[]}));
    }
    for(const id of ['group-a','group-b'])db.prepare('INSERT INTO dingtalk_groups (owner,client_id,robot_code,open_conversation_id,last_seen_at) VALUES(?,?,?,?,?)').run(...robotScope(owner),id,new Date().toISOString());
    const a=await saveSettings(owner,true,'0','3',['group-a'],'09:00',{warehouseCode:'A',turnoverDays:'20',excludedNameKeywords:' 磁吸背盖；磁吸背盖 '});
    await saveSettings(owner,true,'0','1',['group-b'],'11:00',{warehouseCode:'B',turnoverDays:'60',excludedNameKeywords:[]});
    await saveCollectionSchedule(owner,'A','08:10');await saveCollectionSchedule(owner,'B','10:10');
    const aa=await settings(owner,'A'),b=await settings(owner,'B');
    assert.equal(aa.turnoverAverageThreshold,'3');assert.equal(aa.turnoverDays,'20');assert.deepEqual(aa.excludedNameKeywords,['磁吸背盖']);
    assert.equal(aa.notifyTime,'09:00');assert.equal(aa.warehouseSchedule!.dailyTime,'08:10');
    assert.equal(b.notifyTime,'11:00');assert.equal(b.warehouseSchedule!.dailyTime,'10:10');assert.equal(b.turnoverDays,'60');
    assert.deepEqual(aa.groupState.groups.filter(g=>g.enabled).map(g=>g.id),['group-a']);assert.deepEqual(b.groupState.groups.filter(g=>g.enabled).map(g=>g.id),['group-b']);
    const pa=await previewTurnoverAlert(owner,'A'),pb=await previewTurnoverAlert(owner,'B');
    assert.equal(pa.eligibleCount,2);assert.equal(pa.excludedCount,1);assert.equal(pa.count,1);assert.equal(pa.cards[0].rows[0].goodsNo,'CASE');assert.equal(pb.count,3);
    const {rows}=await allRows(owner,'A',7,true),magnet=rows.find(r=>r.goodsNo==='MAGNET')!;
    assert.ok(turnoverAlert(magnet.metrics,magnet.quantity,a.turnoverAverageThreshold,a.turnoverDays),'负库存且名称排除仍标红');
    const narrow=await previewTurnoverAlert(owner,'A','3','18','');assert.equal(narrow.count,1,'周转等于门槛不预警');
    assert.equal((await previewTurnoverAlert(owner,'A','4','60','')).count,0,'销售均值等于门槛不预警');
    assert.equal((await previewTurnoverAlert(owner,'A','3','20','手机壳,磁吸背盖')).count,0);
    assert.equal((await settings(owner,'A')).turnoverDays,'20','草稿预览不更改保存值');
    let sends=0;const sender=async()=>{sends++;return 'mock';};
    for(const [code,report,rule,groups] of [['A',pa,aa,['group-a']],['B',pb,b,['group-b']]] as const){
      const request={requestId:randomUUID(),warehouseCode:code,snapshotId:report.snapshotId,averageThreshold:rule.turnoverAverageThreshold,turnoverDays:rule.turnoverDays,excludedNameKeywords:rule.excludedNameKeywords,groupIds:[...groups]};
      const result=await sendManualAlert(owner,request,sender);assert.equal(result.groups[0].state,'accepted');
      await sendManualAlert(owner,request,sender);
      await assert.rejects(()=>sendManualAlert(owner,{...request,turnoverDays:'21'},sender),/内容已改变/);
    }
    assert.equal(sends,2,'两个仓库互不阻挡，重复请求不重复发送');
    await assert.rejects(()=>saveSettings('stranger',false,'0','3',[],undefined,{warehouseCode:'A'}),/先增加/);
    await assert.rejects(()=>saveCollectionSchedule(owner,'A','25:00'),/每日时间/);
    assert.equal((await settings(owner,'A')).warehouseSchedule!.dailyTime,'08:10');
  } finally {names.forEach((n,i)=>old[i]===undefined?delete process.env[n]:process.env[n]=old[i]);}
});

test('小数周转门槛按精确值比较，排除按名称文字而非正则匹配',()=>{
  const metrics={total7:'7',average7:'1',turnoverDays:'2.13',validDays:7,basis:'inbound_adjusted_difference' as const,reason:null};
  assert.equal(turnoverAlert(metrics,'2.125','0','2.125'),false);
  assert.equal(turnoverAlert(metrics,'2.125','0','2.126'),true);
  assert.deepEqual(normalizeExcludedNames(' ＡＢＣ,abc\n磁吸背盖；手机壳'),['abc','手机壳','磁吸背盖']);
  for(const invalid of ['0','-2','abc','1000001'])assert.throws(()=>normalizeTurnoverDays(invalid),/库存周转门槛/);
});

test('两个仓库分别到点采集、分别到点预警，名称排除同样用于自动通知',async()=>{
  const names=['DINGTALK_CLIENT_ID','DINGTALK_CLIENT_SECRET','DINGTALK_ROBOT_CODE'],old=names.map(n=>process.env[n]);
  names.forEach(n=>process.env[n]='warehouse-test-only');
  const db=sqlite(),sent:{group:string;text:string}[]=[];
  try {
    db.prepare("DELETE FROM manual_alert_deliveries WHERE owner='per-warehouse'").run();
    const sender=async(c:{openConversationId:string},text:string)=>{sent.push({group:c.openConversationId,text});return 'mock';};
    await sendDueAlerts('2026-10-08 08:59:59',sender);assert.equal(sent.length,0);
    await sendDueAlerts('2026-10-08 09:00:00',sender);assert.equal(sent.length,1);assert.equal(sent[0].group,'group-a');assert.doesNotMatch(sent[0].text,/MAGNET/);
    await sendDueAlerts('2026-10-08 10:59:59',sender);assert.equal(sent.length,1);
    await sendDueAlerts('2026-10-08 11:00:00',sender);assert.equal(sent.length,2);assert.equal(sent[1].group,'group-b');assert.match(sent[1].text,/MAGNET/);
    await sendDueAlerts('2026-10-08 12:00:00',sender);assert.equal(sent.length,2);
    const jobs=(code:string)=>db.prepare("SELECT count(*) AS n FROM local_jobs WHERE owner='per-warehouse' AND warehouse_code=?").get(code)!.n;
    enqueueDaily('2031-01-01 08:09:59');assert.equal(jobs('A'),0);assert.equal(jobs('B'),0);
    enqueueDaily('2031-01-01 08:10:00');assert.equal(jobs('A'),1);assert.equal(jobs('B'),0);
    enqueueDaily('2031-01-01 10:10:00');assert.equal(jobs('B'),1);
  } finally {names.forEach((n,i)=>old[i]===undefined?delete process.env[n]:process.env[n]=old[i]);}
});

test('Excel 保存发送时的商品和销售日期，下载令牌校验且过期；localhost 不阻止发送',async()=>{
  const previous=process.env.INVENTORY_SITE_URL;
  try {
    const report=await previewTurnoverAlert('per-warehouse','A');
    for(const site of ['','http://localhost:3108','http://127.0.0.1','http\\://localhost:3108']){
      process.env.INVENTORY_SITE_URL=site;assert.equal(reportExportBaseUrl(),null);assert.equal(attachReportExport('per-warehouse','A',report),report);
    }
    process.env.INVENTORY_SITE_URL='https://inventory.example.com';
    const exported=attachReportExport('per-warehouse','A',report),token=new URL(exported.cards[0].exportUrl!).pathname.split('/').at(-1)!;
    const snapshot=readReportExport(token)!;assert.equal(snapshot.warehouseCode,'A');assert.deepEqual(snapshot.card.rows,report.cards[0].rows);
    report.cards[0].rows[0].goodsName='changed';assert.notEqual(readReportExport(token)!.card.rows[0].goodsName,'changed');
    assert.equal(readReportExport('invalid'),null);assert.equal(readReportExport(token.slice(0,42)+(token[42]==='a'?'b':'a')),null);
    const card=snapshot.card;card.rows[0].goodsNo='0000123';card.rows[0].goodsName='=HYPERLINK("https://example.com")';card.rows[0].quantity='9007199254740993.125';card.rows[0].sales[0]='-2';card.rows[0].sales[1]=null;
    const bytes=alertWorkbook(card);writeFileSync('.sites-runtime/tests/alert-export.xlsx',bytes);
    assert.equal(Buffer.from(bytes).readUInt32LE(),0x04034b50);
    sqlite().prepare('UPDATE alert_report_exports SET expires_at=0').run();assert.equal(readReportExport(token),null);
  } finally {if(previous===undefined)delete process.env.INVENTORY_SITE_URL;else process.env.INVENTORY_SITE_URL=previous;}
});
