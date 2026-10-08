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
import { settings, saveSettings, previewTurnoverAlert, notifyAfterSnapshot } from '../lib/alerts-store';
import { turnoverAlert } from '../lib/turnover-alert';
import { groupState, syncRobotGroups, robotScope } from '../lib/dingtalk-groups-store';
import { randomUUID } from 'node:crypto';
import { sendManualAlert } from '../lib/manual-alerts';
import { DingTalkCardError } from '../lib/dingtalk-cards';
import { sendDueAlerts } from '../lib/scheduled-alerts';
mkdirSync('.sites-runtime/tests',{recursive:true});
process.env.INVENTORY_DB_PATH=resolve(`.sites-runtime/tests/store-${Date.now()}.sqlite`);

test('周转均值门槛默认3，独立保存、旧调用保留设置且按用户隔离',async()=>{
  const owner='turnover-alert-owner',db=sqlite();
  assert.equal((await settings(owner)).turnoverAverageThreshold,'3');
  const saved=await saveSettings(owner,false,'2','04.500');
  assert.equal(saved.turnoverAverageThreshold,'4.5');assert.equal(saved.enabled,false);assert.equal(saved.threshold,'2');
  db.prepare("UPDATE alert_settings SET last_digest='previous-digest',last_result='previous-result' WHERE owner=?").run(owner);
  await saveSettings(owner,false,'5');
  assert.equal((await settings(owner)).turnoverAverageThreshold,'4.5','未传新字段的旧API不会重置门槛');
  assert.equal((await settings('other-turnover-owner')).turnoverAverageThreshold,'3');
  for(const invalid of ['-1','1000001','abc','',null])await assert.rejects(()=>saveSettings(owner,false,'0',invalid),/销量均值门槛/);
  const unchanged=await settings(owner);assert.equal(unchanged.threshold,'5');assert.equal(unchanged.turnoverAverageThreshold,'4.5');assert.equal(unchanged.lastResult,'previous-result');
  assert.equal(db.prepare('SELECT last_digest FROM alert_settings WHERE owner=?').get(owner)!.last_digest,'previous-digest');
  assert.equal((await saveSettings(owner,false,'5','0')).turnoverAverageThreshold,'0','允许门槛0');
});

test('周转群通知汇总全仓超过1000款，短消息、预览不发送及每天原子去重',async()=>{
  const db=sqlite(),owner='notification-owner',code='NOTICE01';
  await addWarehouse(owner,code,'通知分页测试仓');
  for(let i=0;i<8;i++) {
    const date='2026-10-0'+(i+1),id='notice-'+date;
    db.prepare("INSERT INTO stock_snapshots (id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,coverage) VALUES(?,?,?,?,'complete',1,1205,1205,'{}',0,0,?,'auto:v1')").run(id,owner,date,date+'T00:00:23Z',code);
    db.prepare('INSERT INTO daily_slots VALUES(?,?,?,?)').run(owner,code,date,id);
    const rows=Array.from({length:1205},(_,n)=>['G'+String(n).padStart(4,'0'),'预警测试货品','Pcs',String(n===0?100-3*i:n===1?28-4*i:100-4*i),1,1]).filter(r=>!(i===1 && r[0]==='G0002'));
    db.prepare("INSERT INTO stock_entries SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),json_extract(value,'$[4]'),json_extract(value,'$[5]') FROM json_each(?)").run(id,JSON.stringify(rows));
  }
  await reconcileWarehouseInbound(owner,code,'k','s',async()=>{},async()=>({quantity:'0',records:[]}));
  const preview=await previewTurnoverAlert(owner,code,'3');assert.equal(preview.count,1203);assert.match(preview.message,/共 1203 款/);assert.ok(preview.messages.length>1);assert.ok(preview.messages.every(m=>Buffer.byteLength(m)<=3500));assert.equal((preview.message.match(/^\d+\. /gm)||[]).length,1203,'完整报告不截断货品');assert.match(preview.message,/G0001.*0天/);assert.match(preview.message,/G1204/);
  await assert.rejects(()=>previewTurnoverAlert('another-notification-owner',code),/仓库尚未添加/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM turnover_alert_deliveries').get()!.n,0,'预览不产生发送记录');
  for(const size of [100,200,500,1000]) {
    const view=await loadInventory(owner,{warehouseCode:code,pageSize:size,compact:true,sort:"code"});assert.equal(view.rows.length,size);assert.equal(view.pageSize,size);assert.equal(view.totalRows,1205);
    assert.deepEqual(view.rows[0].history,{});assert.equal(view.rows[0].inbound,undefined);assert.equal(view.rows[0].rawSales,undefined);assert.deepEqual(view.rows[0].salesHints,{});
  }
  const next=await loadInventory(owner,{warehouseCode:code,pageSize:1000,page:2,compact:true,sort:"code"});assert.equal(next.rows.length,205);assert.equal(next.rows[0].goodsNo,'G1000');assert.equal(next.rows[204].goodsNo,'G1204');
  const defaults=await loadInventory(owner,{warehouseCode:code,compact:true});
  assert.equal(defaults.rows[0].goodsNo,'G0000');assert.equal(defaults.rows[0].quantity,'79');
  assert.ok(defaults.rows.every((row,i)=>i===0 || compareQuantity(defaults.rows[i-1].quantity,row.quantity)>=0),'无排序参数时按库存精确降序');
  const byCode=await loadInventory(owner,{warehouseCode:code,sort:'code'});assert.equal(byCode.rows[1].goodsNo,'G0001','手动编码排序仍可使用');
  assert.equal(preview.cards.flatMap(c=>c.rows).length,preview.count,'卡片覆盖整个仓库的全部预警货品');
  const names=['DINGTALK_CLIENT_ID','DINGTALK_CLIENT_SECRET','DINGTALK_ROBOT_CODE','DINGTALK_OPEN_CONVERSATION_ID'];const old=names.map(n=>process.env[n]);names.forEach(n=>process.env[n]='isolated-fake');
  let sent=0;const sender=async(_credentials: unknown,message: string)=>{if(!/第\d+\/\d+部分/.test(message)||/第1\/\d+部分/.test(message))sent++;return 'fake-accepted';};
  try {
    db.prepare("INSERT INTO dingtalk_groups (owner,client_id,robot_code,open_conversation_id,last_seen_at,enabled) VALUES(?,?,?,'test-group',?,1)").run(...robotScope(owner),new Date().toISOString());
    await saveSettings(owner,true,'0','4');await notifyAfterSnapshot(owner,preview.snapshotId,code,sender);assert.equal(sent,0,'均值等于门槛不通知');
    await saveSettings(owner,true,'0','3');
    await notifyAfterSnapshot(owner,'stale-snapshot',code,sender);assert.equal(sent,0,'旧快照不通知');
    db.prepare("UPDATE stock_snapshots SET unavailable_skus='[{}]' WHERE id=?").run(preview.snapshotId);await notifyAfterSnapshot(owner,preview.snapshotId,code,sender);assert.equal(sent,0,'库存不完整不通知');
    db.prepare("UPDATE stock_snapshots SET unavailable_skus='[]' WHERE id=?").run(preview.snapshotId);
    await Promise.all([notifyAfterSnapshot(owner,preview.snapshotId,code,sender),notifyAfterSnapshot(owner,preview.snapshotId,code,sender)]);assert.equal(sent,1,'并发只发送一次');
    await saveSettings(owner,true,'0','0');await notifyAfterSnapshot(owner,preview.snapshotId,code,sender);assert.equal(sent,1,'改门槛不重复当天通知');
    assert.equal(db.prepare('SELECT state FROM turnover_group_deliveries WHERE owner=? AND warehouse_code=?').get(owner,code)!.state,'accepted');
    await addWarehouse(owner,'NOTICE02','另一通知仓');
    for(let i=0;i<8;i++) {
      const date='2026-10-0'+(i+1),id='other-notice-'+date;
      db.prepare("INSERT INTO stock_snapshots SELECT ?,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,scope_key,scope_label,scope_count,'NOTICE02',warehouse_name,coverage,catalog_hash,unavailable_skus FROM stock_snapshots WHERE id=?").run(id,'notice-'+date);
      db.prepare("INSERT INTO stock_entries SELECT ?,goods_no,goods_name,unit_name,quantity,sku_count,sign FROM stock_entries WHERE snapshot_id=? AND goods_no='G0003'").run(id,'notice-'+date);
      db.prepare('INSERT INTO daily_slots VALUES(?,?,?,?)').run(owner,'NOTICE02',date,id);
    }
    await reconcileWarehouseInbound(owner,'NOTICE02','k','s',async()=>{},async()=>({quantity:'0',records:[]}));
    await notifyAfterSnapshot(owner,'other-notice-2026-10-08','NOTICE02',sender);assert.equal(sent,2,'同用户不同仓库独立每日通知');
    const id='notice-2026-10-09';
    db.prepare("INSERT INTO stock_snapshots (id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,coverage) VALUES(?,?,'2026-10-09','2026-10-09T00:00:23Z','complete',1,1205,1205,'{}',0,0,?,'auto:v1')").run(id,owner,code);
    db.prepare('INSERT INTO stock_entries SELECT ?,goods_no,goods_name,unit_name,quantity,sku_count,sign FROM stock_entries WHERE snapshot_id=?').run(id,preview.snapshotId);
    db.prepare('INSERT INTO daily_slots VALUES(?,?,?,?)').run(owner,code,'2026-10-09',id);
    await reconcileWarehouseInbound(owner,code,'k','s',async()=>{},async()=>({quantity:'0',records:[]}));
    const uncertain=async()=>{sent++;throw Error('timeout');};
    await notifyAfterSnapshot(owner,id,code,uncertain);await notifyAfterSnapshot(owner,id,code,sender);assert.equal(sent,3,'次日可发，发送未确认时不自动重试');
    assert.equal(db.prepare("SELECT state FROM turnover_group_deliveries WHERE owner=? AND date='2026-10-09'").get(owner)!.state,'unconfirmed');
    db.prepare("INSERT INTO dingtalk_groups (owner,client_id,robot_code,open_conversation_id,last_seen_at) VALUES(?,?,?,'second-group',?)").run(...robotScope(owner),new Date().toISOString());
    await saveSettings(owner,true,'0','3',['test-group','second-group']);
    const targets: string[]=[];
    await Promise.all([notifyAfterSnapshot(owner,id,code,async (credentials,message)=>{targets.push(credentials.openConversationId);return sender(credentials,message);}),notifyAfterSnapshot(owner,id,code,sender)]);
    assert.equal(sent,4,'原群未确认不重发，新勾选群独立每日去重');assert.deepEqual([...new Set(targets)],['second-group']);
    await saveSettings(owner,false,'0','3');await notifyAfterSnapshot(owner,id,code,sender);assert.equal(sent,4);
    const currentPreview=await previewTurnoverAlert(owner,code,'3');
    const input={requestId:randomUUID(),warehouseCode:code,snapshotId:id,averageThreshold:'3',groupIds:['test-group','second-group']};
    let manualCalls=0;const manualSender=async()=>{manualCalls++;return 'mock-only';};
    await Promise.all([sendManualAlert(owner,input,manualSender),sendManualAlert(owner,input,manualSender)]);
    const delivered=await sendManualAlert(owner,input,manualSender);
    assert.equal(delivered.state,'complete');assert.equal(delivered.groups.filter(g=>g.state==='accepted').length,2);
    assert.equal(manualCalls,currentPreview.messages.length*2,'自动开关关闭及今日自动已发送仍可手动发，重放不重复');
    assert.ok(delivered.groups.every(g=>g.acceptedParts===g.totalParts));
    await assert.rejects(()=>sendManualAlert(owner,{...input,averageThreshold:'4'},manualSender),/内容已改变/);
    await assert.rejects(()=>sendManualAlert(owner,{...input,requestId:randomUUID()},manualSender),/上次发送尝试不足30秒/);
    await assert.rejects(()=>sendManualAlert('another-owner',input,manualSender),/规则或接收群/);
    await assert.rejects(()=>sendManualAlert(owner,{...input,requestId:randomUUID(),groupIds:['not-owned']},manualSender),/规则或接收群/);
    await assert.rejects(()=>sendManualAlert(owner,{...input,requestId:randomUUID(),snapshotId:'stale'},manualSender),/数据已更新/);
    db.prepare("UPDATE stock_snapshots SET unavailable_skus='[{}]' WHERE id=?").run(id);
    await assert.rejects(()=>sendManualAlert(owner,{...input,requestId:randomUUID()},manualSender),/不完整/);
    db.prepare("UPDATE stock_snapshots SET unavailable_skus='[]' WHERE id=?").run(id);
    db.prepare('UPDATE manual_alert_deliveries SET attempted_at=0 WHERE owner=?').run(owner);
    const partialInput={...input,requestId:randomUUID()};let firstParts=0,otherParts=0;
    const partial=await sendManualAlert(owner,partialInput,async credentials=>{
      if(credentials.openConversationId==='test-group'){firstParts++;if(firstParts===2)throw Error('mock timeout');}else otherParts++;
      return 'mock-accepted';
    });
    assert.equal(partial.groups.find(g=>g.id==='test-group')!.state,'unconfirmed');assert.equal(partial.groups.find(g=>g.id==='test-group')!.acceptedParts,1);
    assert.match(partial.groups.find(g=>g.id==='test-group')!.error!,/未取得有效受理回执/);
    assert.equal(otherParts,currentPreview.messages.length,'一个群的分条失败不影响其他群完整报告');
    await sendManualAlert(owner,partialInput,manualSender);assert.equal(manualCalls,currentPreview.messages.length*2,'部分受理不重试');
    db.prepare('UPDATE manual_alert_deliveries SET attempted_at=0 WHERE owner=?').run(owner);
    const rejectedInput={...input,requestId:randomUUID()};let rejectedCalls=0;
    const rejection=async()=>{rejectedCalls++;throw new DingTalkCardError('钉钉卡片发送失败（HTTP 400；错误码：param.cardTemplateIdInvalid）',true);};
    const rejected=await sendManualAlert(owner,rejectedInput,rejection);
    assert.ok(rejected.groups.every(g=>g.state==='failed' && g.acceptedParts===0));
    assert.match(rejected.message,/2 个群发送失败/);assert.doesNotMatch(rejected.message,/未确认|请到群内查看/);
    assert.ok(rejected.groups.every(g=>g.error?.includes('param.cardTemplateIdInvalid')));
    await sendManualAlert(owner,rejectedInput,rejection);assert.equal(rejectedCalls,2,'明确拒绝的原请求重放也不重发');
    await assert.rejects(()=>sendManualAlert(owner,{...rejectedInput,requestId:randomUUID()},rejection),/发送尝试不足30秒/);
    db.prepare('UPDATE manual_alert_deliveries SET attempted_at=0 WHERE owner=?').run(owner);
    const oldSite=process.env.INVENTORY_SITE_URL,oldTemplate=process.env.DINGTALK_CARD_TEMPLATE_ID,oldFetch=globalThis.fetch;
    let externalCalls=0;
    try {
      process.env.INVENTORY_SITE_URL='http://localhost:3108';process.env.DINGTALK_CARD_TEMPLATE_ID='957e3c25-a2d9-4cd3-a424-be40f18a9f9b';
      globalThis.fetch=(async()=>{externalCalls++;throw Error('禁止真实请求');}) as typeof fetch;
      const configInput={...input,requestId:randomUUID()},configFailed=await sendManualAlert(owner,configInput);
      assert.match(configFailed.message,/2 个群发送失败/);assert.doesNotMatch(configFailed.message,/未确认/);
      assert.ok(configFailed.groups.every(g=>g.state==='failed' && g.acceptedParts===0 && g.totalParts===1 && g.error?.includes('INVENTORY_SITE_URL')));
      assert.equal(externalCalls,0,'地址配置错误时不调用钉钉');
      const replayed=await sendManualAlert(owner,configInput);assert.deepEqual(replayed,configFailed);assert.equal(externalCalls,0);
    } finally {
      if(oldSite===undefined)delete process.env.INVENTORY_SITE_URL;else process.env.INVENTORY_SITE_URL=oldSite;
      if(oldTemplate===undefined)delete process.env.DINGTALK_CARD_TEMPLATE_ID;else process.env.DINGTALK_CARD_TEMPLATE_ID=oldTemplate;
      globalThis.fetch=oldFetch;
    }
    const interruptedInput={...input,requestId:randomUUID()},hashInput={...interruptedInput,groupIds:[...interruptedInput.groupIds].sort()};
    const {createHash}=await import('node:crypto');
    db.prepare("INSERT INTO manual_alert_deliveries VALUES(?,?,?,?,?,?,'sending',?,0)").run(...robotScope(owner),interruptedInput.requestId,createHash('sha256').update(JSON.stringify(hashInput)).digest('hex'),code,JSON.stringify({...partial,state:'sending',groups:[{...partial.groups[0],state:'pending'},{...partial.groups[1],state:'unconfirmed'}]}));
    const interrupted=await sendManualAlert(owner,interruptedInput,manualSender);assert.equal(interrupted.state,'complete');assert.match(interrupted.message,/任务已中断/);assert.equal(manualCalls,currentPreview.messages.length*2,'进程中断后查询也不恢复发送');
  } finally {names.forEach((n,i)=>{if(old[i]===undefined)delete process.env[n];else process.env[n]=old[i];});}
});

test('可编辑采集/预警时间：到点、采集中与旧数据不发，完整当天数据只发一次',async()=>{
  const db=sqlite(),owner='scheduled-owner',code='ALERT01',names=['DINGTALK_CLIENT_ID','DINGTALK_CLIENT_SECRET','DINGTALK_ROBOT_CODE'],old=names.map(n=>process.env[n]);
  names.forEach(n=>process.env[n]='schedule-fake');
  try {
    await addWarehouse(owner,code,'时间测试仓');
    db.prepare("INSERT INTO dingtalk_groups (owner,client_id,robot_code,open_conversation_id,last_seen_at,enabled) VALUES(?,?,?,'schedule-group',?,1)").run(...robotScope(owner),new Date().toISOString());
    const saved=await saveSettings(owner,true,'0','3',['schedule-group'],'09:30',{warehouseCode:code,dailyTime:'09:00'});
    assert.equal(saved.notifyTime,'09:30');assert.equal(saved.warehouseSchedule!.dailyTime,'09:00');
    for(const time of ['25:00','9:30','09:60','',null])await assert.rejects(()=>saveSettings(owner,true,'0','3',['schedule-group'],time),/有效的每日时间/);
    await assert.rejects(()=>saveSettings(owner,true,'0','8',['schedule-group'],'10:00',{warehouseCode:code,dailyTime:'invalid'}),/有效的每日时间/);
    await assert.rejects(()=>saveSettings(owner,true,'0','8',['schedule-group'],'10:00',{warehouseCode:'PRIVATE',dailyTime:'10:00'}),/先增加/);
    assert.equal((await settings(owner)).turnoverAverageThreshold,'3');assert.equal((await settings(owner)).notifyTime,'09:30','校验失败不部分保存');
    assert.equal((await loadInventory(owner,{warehouseCode:code})).dailyTime,'09:00');
    const jobs=()=>Number(db.prepare('SELECT count(*) AS n FROM local_jobs WHERE owner=? AND warehouse_code=?').get(owner,code)!.n);
    enqueueDaily('2031-01-01 08:59:59');assert.equal(jobs(),0);enqueueDaily('2031-01-01 09:00:00');assert.equal(jobs(),1);
    db.prepare('DELETE FROM local_jobs WHERE owner=? AND warehouse_code=?').run(owner,code);
    for(let i=1;i<=8;i++){
      const date='2026-10-0'+i,id='schedule-'+date,source='other-notice-'+date;
      db.prepare("INSERT INTO stock_snapshots SELECT ?,?,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,scope_key,scope_label,scope_count,?,warehouse_name,coverage,catalog_hash,unavailable_skus FROM stock_snapshots WHERE id=?").run(id,owner,code,source);
      db.prepare('INSERT INTO stock_entries SELECT ?,goods_no,goods_name,unit_name,quantity,sku_count,sign FROM stock_entries WHERE snapshot_id=?').run(id,source);
      db.prepare('INSERT INTO daily_slots VALUES(?,?,?,?)').run(owner,code,date,id);
    }
    await reconcileWarehouseInbound(owner,code,'k','s',async()=>{},async()=>({quantity:'0',records:[]}));
    let calls=0;const sender=async()=>{calls++;return 'mock-only';};
    await sendDueAlerts('2026-10-08 09:29:59',sender);assert.equal(calls,0,'预警时间之前不发');
    await sendDueAlerts('2026-10-09 09:30:00',sender);assert.equal(calls,0,'昨天的数据不发');
    const queued=enqueue(owner,code);await sendDueAlerts('2026-10-08 09:30:00',sender);assert.equal(calls,0,'有待采集或采集中任务时等待');
    db.prepare("UPDATE local_jobs SET state='complete' WHERE id=?").run(queued.id);
    await sendDueAlerts('2026-10-08 09:30:00',sender);assert.equal(calls,1);
    await sendDueAlerts('2026-10-08 10:00:00',sender);assert.equal(calls,1,'重复巡检不重新核算和发送');
    await saveSettings(owner,true,'0','0',['schedule-group'],'09:30');await sendDueAlerts('2026-10-08 10:00:00',sender);assert.equal(calls,1,'改门槛仍受每日每群去重保护');
    await saveSettings(owner,false,'0','3',['schedule-group'],'09:30');
  } finally {names.forEach((n,i)=>{if(old[i]===undefined)delete process.env[n];else process.env[n]=old[i];});}
});

test('同步群列表保存勾选，移出及重新加入需重选；失败不清空、凭证及用户隔离',async()=>{
  const names=['DINGTALK_CLIENT_ID','DINGTALK_CLIENT_SECRET','DINGTALK_ROBOT_CODE'],old=names.map(n=>process.env[n]);
  names.forEach(n=>process.env[n]='groups-store-fake');
  const owner='group-sync-owner',db=sqlite();let ids=['cid-first','cid-second'];let failing=false;
  const fetcher: typeof fetch=async(url,options)=>{
    if(String(url).endsWith('/accessToken'))return Response.json({accessToken:'fake',expireIn:7200});
    if(String(url).endsWith('/installed/groups/query'))return failing ? new Response('private',{status:403}) : Response.json({hasMore:false,openConversationIds:ids});
    const body=JSON.parse(String(options?.body));
    return body.openConversationId==='cid-first' ? Response.json({success:true,title:'库存预警测试群',openConversationId:'cid-first'}) : new Response('private',{status:403});
  };
  const refresh=async()=>{db.prepare('UPDATE dingtalk_group_sync SET last_attempt_at=NULL WHERE owner=?').run(owner);return syncRobotGroups(owner,{force:true,fetcher});};
  try {
    const initial=await refresh();assert.equal(initial.groups.length,2);assert.equal(initial.groups[0].enabled,false);assert.ok(initial.groups.some(g=>g.name==='库存预警测试群'));assert.ok(initial.groups.some(g=>g.id==='cid-second' && g.name===''));
    await assert.rejects(()=>saveSettings(owner,true,'0','3',[]),/至少一个/);
    await assert.rejects(()=>saveSettings(owner,true,'0','3',['arbitrary-id']),/群列表已变化/);
    await saveSettings(owner,true,'0','3',['cid-first']);assert.equal(groupState(owner).groups.find(g=>g.id==='cid-first')!.enabled,true);
    await refresh();assert.equal(groupState(owner).groups.find(g=>g.id==='cid-first')!.enabled,true,'仍在群中保留勾选');
    failing=true;const failed=await refresh();assert.match(failed.error!,/HTTP 403/);assert.equal(failed.groups.length,2);assert.equal(failed.groups.find(g=>g.id==='cid-first')!.enabled,true,'同步失败保留已有选择');
    failing=false;ids=['cid-second'];await refresh();assert.equal(groupState(owner).groups.length,1);assert.equal(db.prepare("SELECT enabled FROM dingtalk_groups WHERE owner=? AND open_conversation_id='cid-first'").get(owner)!.enabled,0);
    ids=['cid-first','cid-second'];await refresh();assert.equal(groupState(owner).groups.find(g=>g.id==='cid-first')!.enabled,false,'重新加入不自动启用');
    await saveSettings(owner,false,'0','3',['cid-second']);assert.equal(groupState(owner).groups.find(g=>g.id==='cid-second')!.enabled,true,'群名称不可用时仍可按核实后的群ID选择');
    assert.equal(groupState('another-owner').groups.length,0);
    process.env.DINGTALK_ROBOT_CODE='other-robot';assert.equal(groupState(owner).groups.length,0);await assert.rejects(()=>saveSettings(owner,true,'0','3',['cid-second']),/群列表已变化/);
    process.env.DINGTALK_ROBOT_CODE='groups-store-fake';ids=[];await refresh();assert.equal(groupState(owner).groups.length,0);await assert.rejects(()=>saveSettings(owner,true,'0','3'),/至少一个/);
  } finally {names.forEach((n,i)=>{if(old[i]===undefined)delete process.env[n];else process.env[n]=old[i];});}
});

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
  const stocks={FAST:['100','96','92','88','84','80','76','72'],MIXED:['100','90','92','87','87','86','84','85'],RETURNS:['100','100','102','102','102','102','102','102'],ZERO:['100','98','100','100','100','100','100','100']};
  for(let i=0;i<8;i++){
    const date='2026-10-0'+(i+1),id='net-'+date;
    db.prepare("INSERT INTO stock_snapshots (id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,coverage) VALUES(?,?,?,?,'complete',1,4,4,'{}',0,0,?,'auto:v1')").run(id,owner,date,date+'T00:00:23Z',code);
    db.prepare('INSERT INTO daily_slots VALUES(?,?,?,?)').run(owner,code,date,id);
    for(const [goods,values] of Object.entries(stocks))db.prepare("INSERT INTO stock_entries VALUES(?,?,?,'Pcs',?,1,1)").run(id,goods,goods==='RETURNS'?'退货回补样本':goods==='MIXED'?'正负销量混合样本':goods==='FAST'?'周转预警样本':'净消耗为零样本',values[i]);
  }
  await reconcileWarehouseInbound(owner,code,'k','s',async()=>{},async()=>({quantity:'0',records:[]}));
  const view=await loadInventory(owner,{warehouseCode:code});
  const mixed=view.rows.find(r=>r.goodsNo==='MIXED')!,returned=view.rows.find(r=>r.goodsNo==='RETURNS')!,zero=view.rows.find(r=>r.goodsNo==='ZERO')!;
  const fast=view.rows.find(r=>r.goodsNo==='FAST')!;assert.equal(fast.metrics!.total7,'28');assert.equal(fast.metrics!.average7,'4');assert.equal(fast.metrics!.turnoverDays,'18');assert.equal(turnoverAlert(fast.metrics,fast.quantity,'3'),true);assert.equal(turnoverAlert(fast.metrics,fast.quantity,'4'),false);
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
  assert.equal(db.prepare('SELECT count(*) AS n FROM local_migrations').get()!.n,13);
  const plan=db.prepare("EXPLAIN QUERY PLAN SELECT id FROM stock_snapshots WHERE owner=? AND warehouse_code=? AND coverage='auto:v1' AND status='complete' ORDER BY captured_at DESC,id DESC LIMIT 1").all('test-owner','TEST01');
  assert.ok(plan.some((r:{detail:string})=>r.detail.includes('idx_snapshots_warehouse_latest')));assert.ok(plan.every((r:{detail:string})=>!r.detail.includes('TEMP B-TREE')));
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
  const compact=await loadInventory(owner,{warehouseCode:code,compact:true});
  for(const row of compact.rows) { const full=view.rows.find(r=>r.goodsNo===row.goodsNo)!;assert.deepEqual(row.sales,full.sales);assert.deepEqual(row.metrics,full.metrics);assert.equal(row.inbound,undefined);assert.equal(row.rawSales,undefined); }
  assert.equal(compact.rows.find(r=>r.goodsNo==='A')!.salesHints!['2026-10-02'].hasInbound,true);
  assert.match(compact.rows.find(r=>r.goodsNo==='B')!.salesHints!['2026-10-02'].title,/负销量/);
  assert.equal(compact.rows.find(r=>r.goodsNo==='C')!.salesHints!['2026-10-02'].pendingLabel,'待核验');
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


test('当天第二次采集显示临时销量，连续区间入库累加；次日自动基准定稿且均值只用完整日',async()=>{
  const db=sqlite(),owner='provisional-owner',code='DAY01';await addWarehouse(owner,code,'当天销量测试');
  const insert=db.prepare("INSERT INTO stock_snapshots (id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,coverage) VALUES(?,?,?,?,'complete',1,3,3,'{}',0,0,?,'auto:v1')");
  const entry=db.prepare("INSERT INTO stock_entries VALUES(?,?,?,'Pcs',?,1,1)");
  for(let day=1;day<=8;day++) {
    const date='2026-10-0'+day,id='provisional-'+date;insert.run(id,owner,date,date+'T00:00:23.000Z',code);
    db.prepare('INSERT INTO daily_slots VALUES(?,?,?,?)').run(owner,code,date,id);
    entry.run(id,'DAY','测试',String(108-day));entry.run(id,'RETURN','退货','500');entry.run(id,'UNIT','单位','20');
  }
  const receipt=(id:string,qty:string,date:string):InboundRecord=>({recId:id,docId:id,documentNo:id,goodsNo:'DAY',warehouseCode:code,skuBarcode:'DAY',quantity:qty,unitName:'Pcs',inOutDate:date,createdAt:null,typeName:'调拨入库'});
  const receipts=[receipt('r10','10','2026-10-08T00:30:00.000Z'),receipt('r5','5','2026-10-08T23:00:00.000Z')];
  let queries=0;
  const collector=async(_k:string,_s:string,q:InboundQuery)=>{queries++;return {quantity:'0',records:receipts.filter(r=>r.inOutDate>q.start && r.inOutDate<=q.end)};};
  await reconcileWarehouseInbound(owner,code,'k','s',async()=>{},collector);
  assert.equal((await loadSalesCalendar(owner,code,'DAY','2026-10')).days[7].sales,null,'单次采集无当天销量');
  const capture=async(id:string,date:string,time:string,dayStock:string,returnStock:string)=>{
    insert.run(id,owner,date,time,code);entry.run(id,'DAY','测试',dayStock);entry.run(id,'RETURN','退货',returnStock);
    await reconcileWarehouseInbound(owner,code,'k','s',async()=>{},collector,id);
  };
  await capture('provisional-manual-1','2026-10-08','2026-10-08T01:00:23.000Z','108','502');
  let calendar=await loadSalesCalendar(owner,code,'DAY','2026-10'),day=calendar.days[7];
  assert.equal(day.provisional,true);assert.equal(day.sales,'2');assert.equal(day.correction!.inboundQuantity,'10');assert.equal(day.correction!.records.length,1);
  assert.equal((await loadSalesCalendar(owner,code,'RETURN','2026-10')).days[7].sales,'-2');
  await capture('provisional-manual-2','2026-10-08','2026-10-08T02:00:23.000Z','104','501');
  day=(await loadSalesCalendar(owner,code,'DAY','2026-10')).days[7];assert.equal(day.sales,'6');assert.equal(day.closingQuantity,'104');assert.equal(day.correction!.records.length,1,'入库不重复累加');
  const count=queries;await loadSalesCalendar(owner,code,'RETURN','2026-10');assert.equal(queries,count,'打开日历不触发ERP请求');
  db.prepare("UPDATE stock_entries SET unit_name='箱' WHERE snapshot_id='provisional-manual-1' AND goods_no='DAY'").run();
  assert.equal((await loadSalesCalendar(owner,code,'DAY','2026-10')).days[7].sales,null,'中途单位改变不跨过异常区间');
  db.prepare("UPDATE stock_entries SET unit_name='Pcs' WHERE snapshot_id='provisional-manual-1' AND goods_no='DAY'").run();
  const main=await loadInventory(owner,{warehouseCode:code});assert.equal(main.salesDates!.includes('2026-10-08'),false);assert.equal(main.rows.find(r=>r.goodsNo==='DAY')!.metrics!.average7,'1');
  db.prepare("UPDATE inbound_reconciliations SET status='failed',error='模拟入库查询失败' WHERE owner=? AND after_snapshot_id='provisional-manual-1'").run(owner);
  assert.equal((await loadSalesCalendar(owner,code,'DAY','2026-10')).days[7].sales,null,'中途区间失败不补零');
  db.prepare("UPDATE inbound_reconciliations SET status='verified',error=NULL WHERE owner=? AND after_snapshot_id='provisional-manual-1'").run(owner);
  assert.equal((await loadSalesCalendar(owner,code,'UNIT','2026-10')).days[7].sales,null,'中途缺少货品不跨过缺口');
  await capture('provisional-next-morning','2026-10-09','2026-10-08T22:00:23.000Z','103','501');
  day=(await loadSalesCalendar(owner,code,'DAY','2026-10')).days[7];assert.equal(day.provisional,true);assert.equal(day.sales,'7','次日自动采集前仍是昨日临时区间');
  const finalId='provisional-final';insert.run(finalId,owner,'2026-10-09','2026-10-09T00:00:23.000Z',code);entry.run(finalId,'DAY','测试','101');entry.run(finalId,'RETURN','退货','501');
  db.prepare('INSERT INTO daily_slots VALUES(?,?,?,?)').run(owner,code,'2026-10-09',finalId);
  await reconcileWarehouseInbound(owner,code,'k','s',async()=>{},collector,finalId);
  calendar=await loadSalesCalendar(owner,code,'DAY','2026-10');day=calendar.days[7];
  assert.equal(day.provisional,undefined);assert.equal(day.sales,'14');assert.equal(day.correction!.inboundQuantity,'15');assert.equal(day.correction!.records.length,2);
  assert.equal(calendar.days[8].sales,null,'新一天仅一次采集');
  assert.equal((await loadInventory(owner,{warehouseCode:code})).rows.find(r=>r.goodsNo==='DAY')!.metrics!.average7,'2.86');
  assert.equal((await loadSalesCalendar('another-owner','CK031','DAY','2026-10')).days.every(d=>!d.provisional),true);
});

test('启用云端定时时手动快照不抢占自动每日基准，本地关闭定时仍可手动建基准',async()=>{
  const db=sqlite(),owner='baseline-mode-owner',code='MODE01';await addWarehouse(owner,code,'自动基准');
  db.prepare("UPDATE warehouses SET daily_time='00:00' WHERE owner=? AND code=?").run(owner,code);
  const old=process.env.INVENTORY_SCHEDULE_ENABLED;process.env.INVENTORY_SCHEDULE_ENABLED='true';
  const rows=[{goodsNo:'A',goodsName:'测试',quantity:'100',unitName:'Pcs',skuCount:1}],scope={key:'auto:v1',label:'自动基准',count:1},warehouse={code,name:'自动基准',id:'1',hash:'test'};
  try {
    const manual=await acquireRun(owner,code,'manual');await publishSnapshot(owner,manual,rows,1,1,0,scope,warehouse);
    const date=String(db.prepare('SELECT date FROM stock_snapshots WHERE id=?').get(manual)!.date);
    assert.equal(db.prepare('SELECT snapshot_id FROM daily_slots WHERE owner=?').get(owner),undefined);
    const automatic=await acquireRun(owner,code,'daily:'+date);await publishSnapshot(owner,automatic,rows,1,1,0,scope,warehouse);
    assert.equal(db.prepare('SELECT snapshot_id FROM daily_slots WHERE owner=?').get(owner)!.snapshot_id,automatic);
    const later=await acquireRun(owner,code,'manual');await publishSnapshot(owner,later,rows,1,1,0,scope,warehouse);
    assert.equal(db.prepare('SELECT snapshot_id FROM daily_slots WHERE owner=?').get(owner)!.snapshot_id,automatic,'已定稿基准不改写');
    process.env.INVENTORY_SCHEDULE_ENABLED='false';await addWarehouse(owner,'LOCAL01','本地基准');
    db.prepare("UPDATE warehouses SET daily_time='00:00' WHERE owner=? AND code='LOCAL01'").run(owner);
    const local=await acquireRun(owner,'LOCAL01','manual');await publishSnapshot(owner,local,rows,1,1,0,scope,{...warehouse,code:'LOCAL01'});
    assert.equal(db.prepare("SELECT snapshot_id FROM daily_slots WHERE owner=? AND warehouse_code='LOCAL01'").get(owner)!.snapshot_id,local);
  }finally{if(old===undefined)delete process.env.INVENTORY_SCHEDULE_ENABLED;else process.env.INVENTORY_SCHEDULE_ENABLED=old;}
});
