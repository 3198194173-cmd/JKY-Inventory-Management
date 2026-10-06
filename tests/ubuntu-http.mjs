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
  r=await fetch(url+'/api/warehouses',{method:'POST',headers,body:JSON.stringify({code:'TEST02',name:'测试持久化仓库'})});assert.equal(r.ok,true);
  r=await fetch(url+'/api/sync',{method:'POST',headers,body:JSON.stringify({warehouseCode:'TEST02'})});assert.equal(r.status,202);const queued=await r.json();
  r=await fetch(url+'/api/sync',{method:'POST',headers,body:JSON.stringify({warehouseCode:'TEST02'})});assert.equal((await r.json()).job.id,queued.job.id);
  await stop(server);start();await ready();
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
  assert.match(pageHtml,/>销量均值<span/);assert.match(pageHtml,/>库存周转<span/);
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
  assert.equal(reconciled.rows[0].rawSales[previous],'-3');assert.equal(reconciled.rows[0].sales[previous],'1');
  assert.equal(reconciled.rows[0].inbound[previous].inboundQuantity,'4');assert.equal(reconciled.rows[0].inbound[previous].records[0].documentNo,'TEST-INBOUND-4');
  assert.equal(reconciled.rows[0].currentInbound.correctedQuantity,'0','手动区间不重复记入此前入库');
  r=await fetch(url+'/api/sales-calendar?'+new URLSearchParams({warehouseCode:'TEST02',goodsNo:'TEST-GOODS',month:previous.slice(0,7)}),{headers:{cookie}});
  assert.equal(r.ok,true);const calendar=await r.json(),calendarDay=calendar.days.find(d=>d.date===previous);
  assert.equal(calendarDay.sales,'1');assert.equal(calendarDay.openingQuantity,'14.25');assert.equal(calendarDay.closingQuantity,'17.25');assert.equal(calendarDay.correction.inboundQuantity,'4');
  assert.ok(calendar.days.length>=28 && calendar.days.length<=31);
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
  r=await fetch(url+'/',{headers:{cookie}});const sortedHtml=await r.text();
  // Root defaults to CK031, so verify the controls through a warehouse-specific
  // API above; visual checks use the isolated preview warehouse.
  assert.equal(r.status,200);assert.doesNotMatch(sortedHtml,/>已核验<\/small>/);
  r=await fetch(url+'/api/export?warehouseCode=TEST02',{headers:{cookie}});assert.equal(r.ok,true);assert.ok((await r.arrayBuffer()).byteLength>1000);
  r=await fetch(url+'/api/session',{method:'DELETE',headers});assert.equal(r.ok,true);
  r=await fetch(url+'/api/inventory',{headers:{cookie}});assert.equal(r.ok,false);
  console.log('PASS: 登录/伪造身份拒绝/同源校验/队列去重/重启持久化/独立worker失败回报/网页关闭后采集/worker自动入库修正/Excel导出/退出失效');
} finally {await stop(worker);await stop(server);}
