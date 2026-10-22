import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { sqlite } from '../lib/sqlite.mjs';
import { build } from 'esbuild';
mkdirSync('.sites-runtime/tests', { recursive: true });
await build({entryPoints:['tests/kingdee-fixtures.ts'],outfile:'.sites-runtime/tests/collection-http-fixtures.mjs',bundle:true,platform:'node',target:'node24',format:'esm'});
const {fixture}=await import('../.sites-runtime/tests/collection-http-fixtures.mjs');
const folder = mkdtempSync(resolve('.sites-runtime/tests/xingkong-http-'));
process.env.INVENTORY_DB_PATH = join(folder, 'inventory.sqlite');
const db = sqlite(), date = new Date().toISOString(), tokens = {};
for (const id of ['a', 'b']) {
  db.prepare("INSERT INTO accounts(id,data_owner,provider,corp_id,dingtalk_user_id,union_id,display_name,role,member_state,membership_checked_at,created_at,updated_at) VALUES(?,?,'dingtalk','test-corp',?,?,?,'member','verified',?,?,?)").run(id, 'owner-' + id, id, 'union-' + id, '测试' + id, Date.now(), date, date);
  tokens[id] = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?)').run(createHash('sha256').update(tokens[id]).digest('hex'), id, Date.now() + 86400000, Date.now());
}
cpSync('drizzle', '.next/standalone/drizzle', { recursive: true }); cpSync('public', '.next/standalone/public', { recursive: true }); cpSync('.next/static', '.next/standalone/.next/static', { recursive: true });
const url = 'http://127.0.0.1:3195';
const env = { ...process.env, HOSTNAME: '127.0.0.1', PORT: '3195', INVENTORY_SITE_URL: url, KINGDEE_DB_PATH: join(folder, 'kingdee.sqlite'), KINGDEE_STORAGE_DIR: join(folder, 'files'),
  INVENTORY_DINGTALK_LOGIN_ENABLED: 'true', INVENTORY_LOCAL_LOGIN_ENABLED: 'false', DINGTALK_CORP_ID: 'test-corp', DINGTALK_LOGIN_CLIENT_ID: 'offline-app', DINGTALK_LOGIN_CLIENT_SECRET: 'offline-only', JACKYUN_APP_SECRET: '', DINGTALK_CLIENT_SECRET: '', INVENTORY_SCHEDULE_ENABLED: 'false' };
let server, output = '';
async function start() {
  server = spawn(process.execPath, ['--import', pathToFileURL(resolve('tests/xingkong-fixture-fetch.mjs')).href, '.next/standalone/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', data => output += data); server.stderr.on('data', data => output += data);
  for (let index = 0; index < 80; index++) { try { if ((await fetch(url + '/api/health')).ok) return; } catch {} await new Promise(accept => setTimeout(accept, 150)); }
  throw new Error('Test server did not start: ' + output);
}
async function stop() { if (server?.exitCode === null) { const done = new Promise(accept => server.once('exit', accept)); server.kill(); await done; } }
const headers = who => ({ cookie: 'inventory_session=' + tokens[who], origin: url, 'Content-Type': 'application/json' });
const post = (path, body, who = 'a', token = '', origin = url) => fetch(url + path, { method: 'POST', headers: { ...headers(who), origin, 'X-Kingdee-Session': token }, body: JSON.stringify(body) });
const connectionPath = '/api/kingdee/xingkong/connection', probePath = '/api/kingdee/xingkong/probes';
const collectionPath='/api/kingdee/xingkong/collections';
const credentials = { accountId: '20200417192138569', username: 'offline-user', password: 'offline-password' };
const stock = { kind: 'companyStock', start: '2026-10-01', end: '2026-10-31', schemeId: '6ad1c8d85e3e71' };
try {
  await start();
  assert.equal((await fetch(url + probePath)).status, 401);
  assert.equal((await fetch(url+collectionPath)).status,401);
  assert.equal((await fetch(url + connectionPath, { method: 'POST', headers: { origin: url, 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) })).status, 401);
  assert.equal((await post(connectionPath, credentials, 'a', '', 'https://evil.test')).status, 400);
  assert.equal((await post(connectionPath, { ...credentials, baseUrl: 'http://169.254.169.254/' })).status, 400);
  assert.equal((await post(connectionPath, { ...credentials, password: 'incorrect' })).status, 401);
  let response = await post(connectionPath, credentials); assert.equal(response.status, 200, await response.clone().text());
  const connected = await response.json(); assert.match(response.headers.get('cache-control'), /no-store/);
  assert.doesNotMatch(JSON.stringify(connected), /offline-password|fixture-only-private-session/);
  assert.equal((await post(probePath, stock, 'b', connected.token)).status, 401);
  assert.equal((await post(probePath, stock, 'a', '')).status, 401);
  assert.equal((await post(probePath, { ...stock, Limit: 10000 }, 'a', connected.token)).status, 400);
  response = await post(probePath, stock, 'a', connected.token); assert.equal(response.status, 200, await response.clone().text());
  const sample = (await response.json()).probe; assert.equal(sample.returnedRows, 1); assert.equal(sample.total, 100); assert.equal(sample.sampleOnly, true);
  assert.equal(sample.apiReadComplete, false); assert.equal(sample.queryIdReceived, true); assert.equal(sample.rows[0].FBLANK, null);
  assert.doesNotMatch(JSON.stringify(sample), /offline-password|fixture-only-private-session|fixture-only-private-query/);
  response = await post(probePath, { kind: 'companySales', start: stock.start, end: stock.end, salesOrganization: '103', settleOrganization: '103' }, 'a', connected.token);
  assert.equal(response.status, 200, await response.clone().text()); assert.equal((await response.json()).probe.columns.length, 32);
  const get = (path, who = 'a') => fetch(url + path, { headers: headers(who) });
  assert.equal((await get(probePath + '/' + sample.id, 'b')).status, 404);
  assert.equal((await (await get(probePath, 'b')).json()).probes.length, 0);
  response = await get(probePath + '/' + sample.id + '?download=1'); assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.equal((await (await get('/api/kingdee')).json()).batch, null);
  const sales={kind:'companySales',start:stock.start,end:stock.end,salesOrganization:'103',settleOrganization:'103'};
  assert.equal((await post(collectionPath,sales,'b',connected.token)).status,401);
  assert.equal((await post(collectionPath,sales,'a',connected.token,'https://evil.test')).status,400);
  assert.equal((await post(collectionPath,{...stock,schemeId:'invalid scheme'},'a',connected.token)).status,400);
  response=await post(collectionPath,sales,'a',connected.token);assert.equal(response.status,202,await response.clone().text());
  const collection=(await response.json()).collection;
  let completed;
  for(let i=0;i<100;i++){
    response=await get(collectionPath+'/'+collection.id);assert.equal(response.status,200);
    completed=(await response.json()).collection;
    if(!['running','cancelling'].includes(completed.state))break;
    await new Promise(accept=>setTimeout(accept,100));
  }
  assert.equal(completed.state,'ready',completed.error);assert.equal(completed.progress.businessRows,2);
  assert.equal(completed.progress.subtotalRows,2);assert.equal(completed.progress.excludedCustomerRows,1);assert.equal(completed.progress.includedQuantity,'5');
  assert.equal((await get(collectionPath+'/'+collection.id,'b')).status,404);
  assert.equal((await get(collectionPath+'/'+collection.id+'?download=source','b')).status,404);
  assert.equal((await post(collectionPath+'/'+collection.id+'/cancel',{},'b')).status,404);
  assert.equal((await (await get(collectionPath,'b')).json()).collections.length,0);
  response=await get(collectionPath+'/'+collection.id+'?download=source');assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/spreadsheetml/);assert.ok((await response.arrayBuffer()).byteLength>1000);
  const stats=await (await get(collectionPath+'/'+collection.id+'?download=statistics')).json();assert.equal(stats[0].quantity,'5');
  const imported=new FormData();for(const [kind,bytes] of Object.entries(fixture))if(kind!=='companySales')imported.append(kind,new File([bytes],kind+'.xlsx'));
  imported.append('collectionReferences',JSON.stringify({companySales:collection.id}));
  response=await fetch(url+'/api/kingdee/imports',{method:'POST',headers:{cookie:headers('a').cookie,origin:url},body:imported});assert.equal(response.status,200,await response.clone().text());
  const batch=(await response.json()).batch;assert.equal(batch.summary.totals.companySales,'5');assert.equal(batch.sources.find(s=>s.kind==='companySales').originCollectionId,collection.id);
  const stockConnection=await (await post(connectionPath,credentials)).json();
  response=await post(collectionPath,stock,'a',stockConnection.token);assert.equal(response.status,202,await response.clone().text());
  const stockId=(await response.json()).collection.id;let stockJob;
  for(let i=0;i<100;i++){stockJob=(await (await get(collectionPath+'/'+stockId)).json()).collection;if(!['running','cancelling'].includes(stockJob.state))break;await new Promise(accept=>setTimeout(accept,100));}
  assert.equal(stockJob.state,'ready',stockJob.error);assert.equal(stockJob.progress.includedQuantity,'4');assert.equal(stockJob.stock.excludedQuantity,'7');
  assert.deepEqual((await (await get(collectionPath+'?kind=companySales')).json()).collections.map(job=>job.id),[collection.id]);
  assert.deepEqual((await (await get(collectionPath+'?kind=companyStock')).json()).collections.map(job=>job.id),[stockId]);
  assert.ok((await (await get(probePath+'?kind=companyStock')).json()).probes.every(job=>job.kind==='companyStock'));
  assert.equal((await get(collectionPath+'?kind=unexpected')).status,400);
  const combinedForm=new FormData();combinedForm.append('sourceReferences',JSON.stringify(Object.fromEntries(['storeSales','storeStock','prices'].map(kind=>[kind,batch.id]))));combinedForm.append('collectionReferences',JSON.stringify({companySales:collection.id,companyStock:stockId}));
  response=await fetch(url+'/api/kingdee/imports',{method:'POST',headers:{cookie:headers('a').cookie,origin:url},body:combinedForm});assert.equal(response.status,200,await response.clone().text());
  const combined=(await response.json()).batch;assert.equal(combined.summary.totals.companyStock,'4');assert.equal(combined.summary.totals.companySales,'5');
  const invalid=new FormData();invalid.append('collectionReferences','{"companySales":"../outside"}');
  response=await fetch(url+'/api/kingdee/imports',{method:'POST',headers:{cookie:headers('a').cookie,origin:url},body:invalid});assert.equal(response.status,400);
  assert.equal(db.prepare('SELECT count(*) AS n FROM stock_snapshots').get().n, 0);
  await stop(); await start();
  assert.equal((await (await get(collectionPath+'/'+collection.id)).json()).collection.state,'ready');
  assert.equal((await (await get('/api/kingdee')).json()).batch.id,combined.id);
  assert.equal((await get(probePath + '/' + sample.id)).status, 200);
  assert.equal((await post(probePath, stock, 'a', connected.token)).status, 401);
  const next = await (await post(connectionPath, credentials)).json();
  response = await fetch(url + connectionPath, { method: 'DELETE', headers: { ...headers('a'), 'X-Kingdee-Session': next.token } }); assert.equal(response.status, 200);
  assert.equal((await post(probePath, stock, 'a', next.token)).status, 401);
  assert.doesNotMatch(output, /offline-password|fixture-only-private-session|fixture-only-private-query/);
  const audits = db.prepare("SELECT detail FROM account_audit WHERE action LIKE 'kingdee_xingkong_%'").all();
  assert.ok(audits.length >= 3); assert.doesNotMatch(JSON.stringify(audits), /offline-password|fixture-only-private-session|fixture-only-private-query/);
  console.log('PASS: 星空HTTP离线回归（模拟ERP，未请求真实金蝶）：认证/同源/会话隔离/20行探测/正式销售采集/客户排除/完整来源生成明细/重启/下载/审计脱敏/吉客云不写入');
} catch (error) { console.error(output); throw error; }
finally { await stop(); db.close(); }
