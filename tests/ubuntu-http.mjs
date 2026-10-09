import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,cpSync} from 'node:fs';
import {resolve} from 'node:path';
import {scryptSync} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

mkdirSync('.sites-runtime/tests',{recursive:true});
const path=resolve(`.sites-runtime/tests/http-${Date.now()}.sqlite`);
// Reproduce the standalone files copied into the Docker runtime stage.
cpSync('drizzle','.next/standalone/drizzle',{recursive:true});
cpSync('public','.next/standalone/public',{recursive:true});
cpSync('.next/static','.next/standalone/.next/static',{recursive:true});
const url='http://127.0.0.1:3188',password='Integration-only-password',salt='test-salt';
const env={...process.env,INVENTORY_DB_PATH:path,INVENTORY_SITE_URL:url,INVENTORY_USERNAME:'admin',INVENTORY_PASSWORD_HASH:`${salt}:${scryptSync(password,salt,64).toString('hex')}`,INVENTORY_OWNER_ID:'http-test',INVENTORY_SCHEDULE_ENABLED:'false',JACKYUN_APP_SECRET:'',DINGTALK_CLIENT_SECRET:''};
let server,worker,output='';
function start() {server=spawn(process.execPath,['.next/standalone/server.js'],{env:{...env,HOSTNAME:'127.0.0.1',PORT:'3188'},stdio:['ignore','pipe','pipe']}); server.stdout.on('data',d=>output+=d);server.stderr.on('data',d=>output+=d);}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function ready() {for(let n=0;n<60;n++){try{if((await fetch(url+'/api/health')).ok)return;}catch{} await sleep(500);}throw new Error(output);}
async function stop(child){if(!child||child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill();await done;}
try {
  start();await ready();
  let r=await fetch(url+'/',{redirect:'manual',headers:{'oai-authenticated-user-id':'forged','oai-authenticated-user-email':'fake@example.com'}});
  assert.equal(r.status,307);assert.equal(r.headers.get('location'),'/login');
  r=await fetch(url+'/api/inventory');assert.equal(r.ok,false);
  r=await fetch(url+'/api/sales-calendar?warehouseCode=TEST02&goodsNo=TEST-GOODS&month=2026-10');assert.equal(r.ok,false,'月历需要登录');
  r=await fetch(url+'/api/session',{method:'POST',headers:{origin:'https://evil.example'},body:new URLSearchParams({username:'admin',password}),redirect:'manual'});assert.equal(r.ok,false);
  r=await fetch(url+'/api/session',{method:'POST',headers:{origin:url},body:new URLSearchParams({username:'admin',password}),redirect:'manual'});assert.equal(r.status,303);
  const cookie=r.headers.get('set-cookie').split(';')[0];assert.ok(r.headers.get('set-cookie').includes('HttpOnly'));
  const headers={cookie,origin:url,'content-type':'application/json'};
  r=await fetch(url+'/api/alerts');assert.equal(r.ok,false,'预警设置需要登录');
  r=await fetch(url+'/api/alerts/groups',{method:'POST',headers:{origin:url}});assert.equal(r.ok,false,'群同步需要登录');
  r=await fetch(url+'/api/alerts/groups',{method:'POST',headers:{...headers,origin:'https://evil.example'}});assert.equal(r.ok,false,'群同步拒绝跨来源调用');
  r=await fetch(url+'/api/alerts/groups',{method:'POST',headers});assert.equal(r.ok,false,'未配置凭证不访问钉钉');
  r=await fetch(url+'/api/alerts/send',{method:'POST',headers:{origin:url},body:'{}'});assert.equal(r.ok,false,'主动通知需要登录');
  r=await fetch(url+'/api/alerts/send',{method:'POST',headers:{...headers,origin:'https://evil.example'},body:'{}'});assert.equal(r.ok,false,'主动通知拒绝跨来源调用');
  r=await fetch(url+'/api/alerts/send',{method:'POST',headers,body:'{}'});assert.equal(r.status,400,'主动通知拒绝无效参数');
  r=await fetch(url+'/api/alerts/send',{method:'POST',headers,body:JSON.stringify({requestId:'abcd1234-abcd-4abc-8abc-abcd12345678',warehouseCode:'CK031',snapshotId:'unavailable',averageThreshold:'3',groupIds:['unavailable']})});assert.equal(r.status,400);assert.match((await r.json()).error,/配置钉钉/);
  r=await fetch(url+'/api/alerts/preview?warehouseCode=TEST02');assert.equal(r.ok,false,'通知预览需要登录');
  r=await fetch(url+'/api/alerts',{headers:{cookie}});assert.equal((await r.json()).turnoverAverageThreshold,'3');
  r=await fetch(url+'/api/alerts',{method:'POST',headers:{...headers,origin:'https://evil.example'},body:JSON.stringify({warehouseCode:'CK031',enabled:false,threshold:'0',turnoverAverageThreshold:'9'})});assert.equal(r.ok,false,'拒绝跨来源更改预警');
  r=await fetch(url+'/api/alerts',{method:'POST',headers,body:JSON.stringify({warehouseCode:'CK031',enabled:false,threshold:'0',turnoverAverageThreshold:'4.500'})});assert.equal(r.ok,true);assert.equal((await r.json()).turnoverAverageThreshold,'4.5');
  r=await fetch(url+'/api/alerts',{method:'POST',headers,body:JSON.stringify({warehouseCode:'CK031',enabled:false,threshold:'0',turnoverAverageThreshold:'-1'})});assert.equal(r.ok,false);
  r=await fetch(url+'/api/alerts',{method:'POST',headers,body:JSON.stringify({warehouseCode:'CK031',enabled:false,threshold:'0'})});assert.equal((await r.json()).turnoverAverageThreshold,'4.5','旧调用保留设置');
  r=await fetch(url+'/api/warehouses',{method:'POST',headers,body:JSON.stringify({code:'TEST02',name:'测试持久化仓库'})});assert.equal(r.ok,true);
  r=await fetch(url+'/api/alerts',{method:'POST',headers,body:JSON.stringify({enabled:false,threshold:'0',turnoverAverageThreshold:'4.5',notifyTime:'09:15',warehouseCode:'TEST02',turnoverDays:'15',excludedNameKeywords:'磁吸背盖'})});assert.equal(r.ok,true);const scheduledSettings=await r.json();assert.equal(scheduledSettings.notifyTime,'09:15');assert.equal(scheduledSettings.turnoverDays,'15');assert.deepEqual(scheduledSettings.excludedNameKeywords,['磁吸背盖']);
  r=await fetch(url+'/api/warehouses/schedule',{method:'POST',headers,body:JSON.stringify({warehouseCode:'TEST02',dailyTime:'00:00'})});assert.equal(r.ok,true);assert.equal((await r.json()).dailyTime,'00:00');
  r=await fetch(url+'/api/alerts?warehouseCode=CK031',{headers:{cookie}});const independent=await r.json();assert.equal(independent.notifyTime,'08:30');assert.equal(independent.turnoverDays,'30');assert.deepEqual(independent.excludedNameKeywords,[]);
  r=await fetch(url+'/api/alerts/export?warehouseCode=TEST02');assert.equal(r.ok,false);
  r=await fetch(url+'/api/alerts/reports/not-a-token');assert.equal(r.status,404);
  r=await fetch(url+'/api/alerts',{method:'POST',headers,body:JSON.stringify({warehouseCode:'CK031',enabled:false,threshold:'0',notifyTime:'26:00'})});assert.equal(r.status,400,'非法自动预警时间不保存');
  r=await fetch(url+'/api/sync',{method:'POST',headers,body:JSON.stringify({warehouseCode:'TEST02'})});assert.equal(r.status,202);const queued=await r.json();
  r=await fetch(url+'/api/sync',{method:'POST',headers,body:JSON.stringify({warehouseCode:'TEST02'})});assert.equal((await r.json()).job.id,queued.job.id);
  await stop(server);start();await ready();
  r=await fetch(url+'/api/alerts',{headers:{cookie}});assert.equal((await r.json()).turnoverAverageThreshold,'4.5','重启后保留预警门槛');
  r=await fetch(url+'/api/inventory?warehouseCode=TEST02',{headers:{cookie}});assert.equal((await r.json()).warehouseCode,'TEST02');
  worker=spawn(process.execPath,['build-node/worker.mjs'],{env,stdio:['ignore','pipe','pipe']});worker.stderr.on('data',d=>output+=d);
  let state;
  for(let i=0;i<40;i++){
    const db=new DatabaseSync(path);state=db.prepare('SELECT state FROM local_jobs WHERE id=?').get(queued.job.id)?.state;db.close();
    if(state==='failed')break;await sleep(250);
  }
  assert.equal(state,'failed',output);
  r=await fetch(url+'/api/sync?warehouseCode=TEST02',{headers:{cookie}});const runs=(await r.json()).runs;assert.equal(runs[0].status,'failed');assert.equal(runs[0].id,queued.job.id);
  await stop(worker);
  // Simulate restart after an ungraceful process exit without waiting for the lease timeout.
  { const db=new DatabaseSync(path);db.prepare("UPDATE local_worker SET heartbeat='2000-01-01T00:00:00Z'").run();db.close(); }
  r=await fetch(url+'/api/sync',{method:'POST',headers,body:JSON.stringify({warehouseCode:'TEST02'})});const successJob=(await r.json()).job;
  await stop(server); // No HTTP server/browser connection remains while collection runs.
  worker=spawn(process.execPath,['--import','./tests/mock-jackyun.mjs','build-node/worker.mjs'],{env:{...env,JACKYUN_APP_SECRET:'test-only-fake-secret'},stdio:['ignore','pipe','pipe']});worker.stderr.on('data',d=>output+=d);
  for(let i=0;i<60;i++){
    const db=new DatabaseSync(path);state=db.prepare('SELECT state FROM local_jobs WHERE id=?').get(successJob.id)?.state;db.close();
    if(state==='complete'||state==='failed')break;await sleep(250);
  }
  assert.equal(state,'complete',output);
  start();await ready();
  r=await fetch(url+'/api/inventory?warehouseCode=TEST02',{headers:{cookie}});const inventory=await r.json();assert.equal(inventory.rows[0].quantity,'17.25');
  assert.equal(inventory.rows[0].metrics.average7,null);
  assert.equal(inventory.rows[0].metrics.reason,'insufficient_data');
  r=await fetch(url+'/',{headers:{cookie}});const pageHtml=await r.text();assert.equal(r.status,200);
  assert.match(pageHtml,/>销量均值<\/th>/);assert.match(pageHtml,/>库存周转<\/th>/);assert.doesNotMatch(pageHtml,/<span>近7天 · 估算<\/span>|<span>天 · 估算<\/span>|<span>销售量<\/span>/);
  assert.doesNotMatch(pageHtml,/<th[^>]*>单位<\/th>/);
  // Seed a preceding fixed baseline, then let a real worker collection perform
  // its own signed (mock gateway) inbound lookup and persist the correction.
  const priorDate=new Date(inventory.snapshot.date+'T00:00:00Z');priorDate.setUTCDate(priorDate.getUTCDate()-1);const previous=priorDate.toISOString().slice(0,10);
  {
    const db=new DatabaseSync(path);db.exec('BEGIN IMMEDIATE');
    db.prepare("INSERT INTO stock_snapshots (id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,coverage) VALUES('http-inbound-before','http-test',?,?,'complete',1,1,1,'{}',0,0,'TEST02','auto:v1')").run(previous,previous+'T00:00:00Z');
    db.prepare("INSERT INTO stock_entries VALUES('http-inbound-before','TEST-GOODS','测试商品','Pcs','14.25',1,1)").run();
    db.prepare("INSERT INTO daily_slots VALUES('http-test','TEST02',?,'http-inbound-before')").run(previous);
    db.prepare("INSERT OR IGNORE INTO daily_slots VALUES('http-test','TEST02',?,?)").run(inventory.snapshot.date,inventory.snapshot.id);
    db.exec('COMMIT');db.close();
  }
  r=await fetch(url+'/api/sync',{method:'POST',headers,body:JSON.stringify({warehouseCode:'TEST02'})});const inboundJob=(await r.json()).job;
  for(let i=0;i<60;i++){
    const db=new DatabaseSync(path);state=db.prepare('SELECT state FROM local_jobs WHERE id=?').get(inboundJob.id)?.state;db.close();
    if(state==='complete'||state==='failed')break;await sleep(250);
  }
  assert.equal(state,'complete',output);
  r=await fetch(url+'/api/inventory?warehouseCode=TEST02',{headers:{cookie}});const reconciled=await r.json();
  assert.equal(reconciled.rows[0].rawSales,undefined);assert.equal(reconciled.rows[0].sales[previous],'1');
  assert.equal(reconciled.rows[0].inbound,undefined);assert.equal(reconciled.rows[0].salesHints[previous].hasInbound,true,'主表保留入库黄色标识而不加载单据详情');assert.match(reconciled.rows[0].salesHints[previous].title,/原始差额 -3 \+ 入库 4/);
  assert.equal(reconciled.rows[0].currentInbound,undefined,'主表省略手动区间详情');
  {
    const db=new DatabaseSync(path);
    assert.equal(db.prepare("SELECT corrected_quantity FROM inbound_reconciliations WHERE owner='http-test' AND warehouse_code='TEST02' AND goods_no='TEST-GOODS' AND before_snapshot_id=? AND after_snapshot_id=?").get(inventory.snapshot.id,reconciled.snapshot.id).corrected_quantity,'0','手动区间仍保存且不重复记入此前入库');db.close();
  }
  r=await fetch(url+'/api/sales-calendar?'+new URLSearchParams({warehouseCode:'TEST02',goodsNo:'TEST-GOODS',month:previous.slice(0,7)}),{headers:{cookie}});
  assert.equal(r.ok,true);const calendar=await r.json(),calendarDay=calendar.days.find(d=>d.date===previous);
  assert.equal(calendarDay.sales,'1');assert.equal(calendarDay.openingQuantity,'14.25');assert.equal(calendarDay.closingQuantity,'17.25');assert.equal(calendarDay.correction.inboundQuantity,'4');
  assert.equal(calendarDay.correction.records[0].documentNo,'TEST-INBOUND-4','日历按需加载真实单据详情');
  assert.ok(calendar.days.length>=28 && calendar.days.length<=31);
  r=await fetch(url+'/api/sales-calendar?'+new URLSearchParams({warehouseCode:'TEST02',goodsNo:'TEST-GOODS',month:reconciled.snapshot.date.slice(0,7)}),{headers:{cookie}});
  assert.equal(r.ok,true);const today=(await r.json()).days.find(d=>d.date===reconciled.snapshot.date);
  assert.equal(today.provisional,true);assert.equal(today.sales,'0');assert.equal(today.windowEnd,reconciled.snapshot.capturedAt,'真实HTTP返回截至最新采集的临时销量');
  r=await fetch(url+'/api/sales-calendar?warehouseCode=TEST02&goodsNo=TEST-GOODS&month=2026-13',{headers:{cookie}});assert.equal(r.status,400);
  r=await fetch(url+'/api/sync?warehouseCode=TEST02',{headers:{cookie}});assert.match((await r.json()).runs[0].message,/仓库入库核验 2 个区间、2 个货品区间：已核算 2/);
  {
    const db=new DatabaseSync(path);
    for(const [goods,before] of [['Z-SALE','2'],['M-PENDING','3']]) {
      for(const id of ['http-inbound-before',inventory.snapshot.id,reconciled.snapshot.id])db.prepare('INSERT INTO stock_entries VALUES(?,?,?,?,?,1,1)').run(id,goods,'排序测试','Pcs',id==='http-inbound-before'?before:'0');
    }
    db.prepare("INSERT INTO inbound_reconciliations (owner,warehouse_code,goods_no,date,before_snapshot_id,after_snapshot_id,unit_name,raw_difference,opening_quantity,closing_quantity,status,inbound_quantity,corrected_quantity,window_start,window_end,checked_at,query_scope) VALUES('http-test','TEST02','Z-SALE',?,'http-inbound-before',?,'Pcs','2','2','0','verified','0','2',?,?,?,'warehouse:v1')").run(previous,inventory.snapshot.id,previous+'T00:00:00Z',inventory.snapshot.capturedAt,inventory.snapshot.capturedAt);db.close();
  }
  for(const [sort,order] of [['sales_desc',['Z-SALE','TEST-GOODS','M-PENDING']],['sales_asc',['TEST-GOODS','Z-SALE','M-PENDING']]]) {
    r=await fetch(url+'/api/inventory?'+new URLSearchParams({warehouseCode:'TEST02',sort,sortDate:previous}),{headers:{cookie}});
    assert.deepEqual((await r.json()).rows.map(row=>row.goodsNo),order,'HTTP传递指定日期并按真实核算值排序');
  }
  r=await fetch(url+'/api/alerts/preview?warehouseCode=TEST02&averageThreshold=-1',{headers:{cookie}});assert.equal(r.status,400);
  r=await fetch(url+'/api/alerts/preview?warehouseCode=TEST02',{headers:{cookie}});assert.equal(r.ok,true);assert.equal((await r.json()).count,0);
  r=await fetch(url+'/api/alerts/preview?warehouseCode=PRIVATE-WAREHOUSE',{headers:{cookie}});assert.equal(r.ok,false,'不能预览未授权仓库');
  {
    const db=new DatabaseSync(path);
    const rows=Array.from({length:1205},(_,i)=>['P'+String(i).padStart(4,'0'),'大页测试货品','Pcs',String(i),1,1]);
    db.prepare("INSERT INTO stock_entries SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),json_extract(value,'$[4]'),json_extract(value,'$[5]') FROM json_each(?)").run(reconciled.snapshot.id,JSON.stringify(rows));db.close();
    for(const [size,page,length] of [[100,1,100],[200,1,200],[500,1,500],[1000,1,1000],[1000,2,208],[100,1,100]]) {
      r=await fetch(url+'/api/inventory?'+new URLSearchParams({warehouseCode:'TEST02',pageSize:String(size),page:String(page)}),{headers:{cookie}});
      assert.equal(r.ok,true);const data=await r.json();assert.equal(data.pageSize,size);assert.equal(data.page,page);assert.equal(data.rows.length,length);assert.equal(data.totalRows,1208);assert.deepEqual(data.rows[0].history,{});
      assert.ok(data.rows.every((row,i)=>i===0 || Number(data.rows[i-1].quantity)>=Number(row.quantity)),'HTTP无排序参数时默认库存降序');
    }
  }
  r=await fetch(url+'/',{headers:{cookie}});const sortedHtml=await r.text();
  // Root defaults to CK031, so verify the controls through a warehouse-specific
  // API above; visual checks use the isolated preview warehouse.
  assert.equal(r.status,200);assert.doesNotMatch(sortedHtml,/>已核验<\/small>/);
  r=await fetch(url+'/api/export?warehouseCode=TEST02',{headers:{cookie}});assert.equal(r.ok,true);assert.ok((await r.arrayBuffer()).byteLength>1000);
  r=await fetch(url+'/api/session',{method:'DELETE',headers});assert.equal(r.ok,true);
  r=await fetch(url+'/api/inventory',{headers:{cookie}});assert.equal(r.ok,false);
  console.log('PASS: 登录/伪造身份拒绝/同源校验/队列去重/重启持久化/独立worker失败回报/网页关闭后采集/worker自动入库修正/Excel导出/退出失效');
} finally {await stop(worker);await stop(server);}
