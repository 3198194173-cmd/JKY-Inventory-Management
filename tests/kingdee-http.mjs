import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { sqlite } from '../lib/sqlite.mjs';

mkdirSync('.sites-runtime/tests', { recursive: true });
await build({ entryPoints: ['tests/kingdee-fixtures.ts'], outfile: '.sites-runtime/tests/kingdee-fixtures.mjs', bundle: true, platform: 'node', target: 'node24', format: 'esm' });
const { fixture, xlsx } = await import('../.sites-runtime/tests/kingdee-fixtures.mjs');
const folder = mkdtempSync(resolve('.sites-runtime/tests/kd-http-'));
process.env.INVENTORY_DB_PATH = join(folder, 'inventory.sqlite');
const db = sqlite(), date = new Date().toISOString(), tokens = {};
for (const id of ['a','b']) {
  db.prepare("INSERT INTO accounts(id,data_owner,provider,corp_id,dingtalk_user_id,union_id,display_name,role,member_state,membership_checked_at,created_at,updated_at) VALUES(?,?,'dingtalk','test-corp',?,?,?,'member','verified',?,?,?)").run(id, 'owner-' + id, id, 'union-' + id, '测试' + id, Date.now(), date, date);
  tokens[id] = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?)').run(createHash('sha256').update(tokens[id]).digest('hex'), id, Date.now() + 86400000, Date.now());
}
cpSync('drizzle','.next/standalone/drizzle',{recursive:true}); cpSync('public','.next/standalone/public',{recursive:true}); cpSync('.next/static','.next/standalone/.next/static',{recursive:true});
const url = 'http://127.0.0.1:3194';
const env = { ...process.env, HOSTNAME:'127.0.0.1', PORT:'3194', INVENTORY_SITE_URL:url, KINGDEE_DB_PATH:join(folder,'kingdee.sqlite'), KINGDEE_STORAGE_DIR:join(folder,'files'),
  INVENTORY_DINGTALK_LOGIN_ENABLED:'true', INVENTORY_LOCAL_LOGIN_ENABLED:'false', DINGTALK_CORP_ID:'test-corp', DINGTALK_LOGIN_CLIENT_ID:'offline-app',DINGTALK_LOGIN_CLIENT_SECRET:'offline-only', JACKYUN_APP_SECRET:'',DINGTALK_CLIENT_SECRET:'',INVENTORY_SCHEDULE_ENABLED:'false' };
let server, output = '';
async function start() {
  server = spawn(process.execPath, ['.next/standalone/server.js'], { env, stdio:['ignore','pipe','pipe'] });
  server.stdout.on('data', data => output += data); server.stderr.on('data', data => output += data);
  for(let i=0;i<80;i++) { try { if ((await fetch(url+'/api/health')).ok) return; } catch {} await new Promise(accept=>setTimeout(accept,150)); }
  throw new Error('Test server did not start: '+output);
}
async function stop() { if (server?.exitCode === null) { const done=new Promise(accept=>server.once('exit',accept));server.kill();await done; } }
const headers = who => ({ cookie:'inventory_session='+tokens[who], origin:url });
const get = (path,who='a') => fetch(url+path,{headers:headers(who)});
const putRules = (members, origin=url) => fetch(url+'/api/kingdee/warehouses',{method:'PUT',headers:{...headers('a'),origin,'Content-Type':'application/json'},body:JSON.stringify({members})});
const period={start:'2026-10-01',end:'2026-10-31',stockDate:'2026-10-23'};
const columns=JSON.parse(readFileSync('data/kingdee-template.json','utf8')).columns;
const legacy=xlsx([Object.fromEntries(columns.map(c=>[c.key,c.label])),{E:'A',F:'原甲',CD:'99'},{E:'B',F:'原乙'}],'明细');
function form(bad=false) { const data=new FormData(); for(const [kind,bytes] of Object.entries(fixture)) data.append(kind,new File([bad&&kind==='prices'?Buffer.from('invalid'):bytes],kind+'.xlsx'));data.append('legacy',new File([legacy],'原明细.xlsx'));data.append('inheritance',JSON.stringify({period}));return data; }
try {
  await start();
  const loginPage = await (await fetch(url + '/login?returnTo=/kingdee')).text();
  assert.match(loginPage, /使用公司钉钉登录/); assert.doesNotMatch(loginPage, /name="password"|action="\/api\/session"/);
  assert.equal((await fetch(url+'/api/kingdee')).status,401);
  assert.equal((await fetch(url+'/api/kingdee/collection-runs')).status,401);
  const runs=await get('/api/kingdee/collection-runs');assert.equal(runs.status,200);assert.match(runs.headers.get('cache-control'),/no-store/);assert.deepEqual((await runs.json()).runs,[]);
  assert.equal((await fetch(url+'/api/kingdee/collection-runs',{method:'POST',headers:{...headers('a'),origin:'https://evil.test','Content-Type':'application/json'},body:JSON.stringify({kinds:['goods']})})).status,400);
  assert.equal((await fetch(url+'/api/kingdee/collection-runs',{method:'POST',headers:{...headers('a'),'Content-Type':'application/json'},body:JSON.stringify({kinds:['unknown']})})).status,400);
  assert.equal((await fetch(url+'/api/kingdee/collection-runs',{method:'DELETE',headers:{...headers('b'),'Content-Type':'application/json'},body:JSON.stringify({id:'unowned'})})).status,404);
  assert.equal((await putRules([{name:'内仓',group:'inner'}],'https://evil.test')).status,400);
  assert.equal((await putRules([{name:'内仓',group:'inner'},{name:'外仓',group:'outer'}])).status,200);
  let response=await fetch(url+'/api/kingdee/imports',{method:'POST',headers:headers('a'),body:form()});assert.equal(response.status,200,await response.clone().text());
  const first=(await response.json()).batch;assert.equal(first.summary.totals.companyStock,'15');
  response=await get('/api/kingdee');let view=await response.json();assert.equal(view.totalRows,2);assert.equal(view.rows[0].companyAmount,'12.5');assert.match(response.headers.get('cache-control'),/no-store/);
  assert.equal(view.pageSize,1000);assert.equal(view.coverage.goods,2);assert.equal(view.coverage.companySales,2);assert.equal(view.coverage.legacy,2);
  for(const pageSize of [100,500,1000]){const page=await (await get('/api/kingdee?pageSize='+pageSize)).json();assert.equal(page.pageSize,pageSize);assert.equal(page.totalRows,2);assert.deepEqual(page.coverage,view.coverage);}
  assert.equal((await (await get('/api/kingdee?pageSize=50000')).json()).pageSize,1000);
  assert.equal((await (await get('/api/kingdee','b')).json()).totalRows,0);
  assert.equal((await get('/api/kingdee?batch='+first.id,'b')).status,404);
  assert.equal((await get('/api/kingdee/export?batch='+first.id,'b')).status,404);
  response=await fetch(url+'/api/kingdee/recalculate',{method:'POST',headers:{...headers('b'),'Content-Type':'application/json'},body:JSON.stringify({batch:first.id})});assert.equal(response.status,404);
  response=await get('/api/kingdee/export?batch='+first.id);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/spreadsheetml/);assert.ok((await response.arrayBuffer()).byteLength>1000);
  response=await get('/api/kingdee?q=%25_');assert.equal((await response.json()).totalRows,0);
  response=await get('/api/kingdee?column=CK&contains=4');assert.equal((await response.json()).totalRows,1);
  response=await get('/api/kingdee?column=CK&direction=asc');assert.equal((await response.json()).rows[0].code,'B');
  const references=Object.fromEntries(first.sources.map(source=>[source.kind,first.id]));
  const reusedForm=new FormData();reusedForm.append('inheritance',JSON.stringify({baseBatchId:first.id,period}));reusedForm.append('sourceReferences',JSON.stringify(references));
  response=await fetch(url+'/api/kingdee/imports',{method:'POST',headers:headers('a'),body:reusedForm});assert.equal(response.status,200,await response.clone().text());
  const reused=(await response.json()).batch;assert.equal(reused.summary.totals.companyStock,'15');assert.ok(reused.sources.every(source=>source.originBatchId===first.id));
  const crossAccount=new FormData();crossAccount.append('inheritance',JSON.stringify({baseBatchId:first.id,period}));crossAccount.append('sourceReferences',JSON.stringify(references));
  response=await fetch(url+'/api/kingdee/imports',{method:'POST',headers:headers('b'),body:crossAccount});assert.equal(response.status,404);
  const mixed=new FormData();mixed.append('inheritance',JSON.stringify({baseBatchId:first.id,period}));mixed.append('sourceReferences',JSON.stringify({...references,storeStock:undefined}));mixed.append('storeStock',new File([fixture.storeStock],'新门店库存.xlsx'));
  response=await fetch(url+'/api/kingdee/imports',{method:'POST',headers:headers('a'),body:mixed});assert.equal(response.status,200,await response.clone().text());
  const mixedBatch=(await response.json()).batch;assert.equal(mixedBatch.sources.find(source=>source.kind==='storeStock').name,'新门店库存.xlsx');assert.equal(mixedBatch.sources.find(source=>source.kind==='storeStock').originBatchId,undefined);
  const invalidReference=new FormData();invalidReference.append('sourceReferences','{"prices":"../outside"}');
  response=await fetch(url+'/api/kingdee/imports',{method:'POST',headers:headers('a'),body:invalidReference});assert.equal(response.status,400);
  await putRules([{name:'内仓',group:'inner'}]);
  response=await fetch(url+'/api/kingdee/recalculate',{method:'POST',headers:{...headers('a'),'Content-Type':'application/json'},body:JSON.stringify({batch:first.id})});assert.equal(response.status,200);
  const second=(await response.json()).batch;assert.notEqual(second.id,first.id);assert.equal(second.summary.totals.companyStock,'12');
  assert.equal((await (await get('/api/kingdee?batch='+first.id)).json()).batch.summary.totals.companyStock,'15');
  response=await fetch(url+'/api/kingdee/imports',{method:'POST',headers:headers('a'),body:form(true)});assert.equal(response.status,400);
  assert.equal((await (await get('/api/kingdee')).json()).batch.id,second.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM warehouses').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_snapshots').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM local_jobs').get().n,0);
  await stop();await start();
  view=await (await get('/api/kingdee')).json();assert.equal(view.batch.id,second.id);
  assert.equal((await (await get('/api/kingdee','b')).json()).batch,null);
  console.log('PASS: 金蝶HTTP上传/分页/导出/分组重算/历史保留/损坏拒绝/跨账户拒绝/CSRF/重启持久化，吉客云业务表未写入');
} finally { await stop(); }
