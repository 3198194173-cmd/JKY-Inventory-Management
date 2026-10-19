import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { sqlite } from '../lib/sqlite.mjs';

mkdirSync('.sites-runtime/tests', { recursive: true });
process.env.INVENTORY_DB_PATH = resolve(`.sites-runtime/tests/discovery-http-${Date.now()}.sqlite`);
const db = sqlite(), now = new Date().toISOString(), tokens = {};
for (const id of ['fresh', 'existing']) {
  db.prepare("INSERT INTO accounts(id,data_owner,provider,corp_id,dingtalk_user_id,union_id,display_name,role,member_state,membership_checked_at,created_at,updated_at) VALUES(?,?,'dingtalk','test-corp',?,?,?,'member','verified',?,?,?)").run(id, 'owner-' + id, id, 'union-' + id, id, Date.now(), now, now);
  tokens[id] = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?)').run(createHash('sha256').update(tokens[id]).digest('hex'), id, Date.now() + 86400000, Date.now());
}
db.prepare("INSERT INTO warehouses(owner,code,name,created_at) VALUES('owner-existing','EXISTING','已有仓库',?)").run(now);
cpSync('drizzle', '.next/standalone/drizzle', { recursive: true });
cpSync('public', '.next/standalone/public', { recursive: true });
cpSync('.next/static', '.next/standalone/.next/static', { recursive: true });
const url = 'http://127.0.0.1:3194';
const env = { ...process.env, HOSTNAME: '127.0.0.1', PORT: '3194', INVENTORY_SITE_URL: url, INVENTORY_DINGTALK_LOGIN_ENABLED: 'true', INVENTORY_LOCAL_LOGIN_ENABLED: 'false', DINGTALK_CORP_ID: 'test-corp', DINGTALK_ADMIN_UNION_ID: 'no-admin', DINGTALK_LOGIN_CLIENT_ID: 'offline-app', DINGTALK_LOGIN_CLIENT_SECRET: 'offline-secret', JACKYUN_APP_SECRET: 'offline-only', DINGTALK_CLIENT_SECRET: '', INVENTORY_SCHEDULE_ENABLED: 'false' };
let output = '';
let worker;
const server = spawn(process.execPath, ['--import', pathToFileURL(resolve('tests/mock-jackyun.mjs')).href, '.next/standalone/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', d => output += d); server.stderr.on('data', d => output += d);
const headers = who => ({ cookie: 'inventory_session=' + tokens[who], origin: url, 'Content-Type': 'application/json' });
const add = (who, body, extra = {}) => fetch(url + '/api/warehouses', { method: 'POST', headers: { ...headers(who), ...extra }, body: JSON.stringify(body) });
try {
  let ready = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(url + '/api/health')).ok) { ready = true; break; } } catch {} if (server.exitCode !== null) break; await new Promise(r => setTimeout(r, 150)); }
  assert.equal(ready, true, output);
  let r = await fetch(url + '/api/warehouses/available'); assert.equal(r.status, 401, output);
  r = await fetch(url + '/api/warehouses/available', { headers: headers('fresh') });
  assert.equal(r.status, 200, output); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await r.json()).warehouses, [{ code: 'AUTO_TEST', name: '测试自动获取仓库', warehouseId: '999' }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM warehouses WHERE owner='owner-fresh'").get().n, 0, '读取列表不自动添加所有仓库');
  r = await add('fresh', { code: 'AUTO_TEST', source: 'jackyun', initialize: true }, { origin: 'https://evil.example' }); assert.equal(r.status, 400);
  r = await add('fresh', { code: 'FORGED', source: 'jackyun', initialize: true }); assert.equal(r.status, 400);
  if (process.env.TEST_BROWSER === 'true') {
    const { chromium } = await import('file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await context.addCookies([{ name: 'inventory_session', value: tokens.fresh, url }]);
      const page = await context.newPage();
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto(url + '/');
      const selector = page.getByLabel(/选择仓库（/);
      await selector.locator('option[value=AUTO_TEST]').waitFor({ state: 'attached' });
      assert.equal(await page.getByRole('button', { name: '添加并初始化采集' }).isDisabled(), true);
      await page.getByLabel('搜索仓库名称或编码').fill('自动获取');
      await selector.selectOption('AUTO_TEST');
      await page.getByLabel('搜索仓库名称或编码').fill('无匹配仓库');
      assert.equal(await page.getByRole('button', { name: '添加并初始化采集' }).isDisabled(), true, '筛选变化不能提交隐藏的旧选择');
      await page.getByLabel('搜索仓库名称或编码').fill('自动获取');
      await selector.selectOption('AUTO_TEST');
      await Promise.all([page.waitForResponse(r => r.url().includes('/api/warehouses/available?refresh=1')), page.getByRole('button', { name: '重新获取', exact: true }).click()]);
      await selector.locator('option[value=AUTO_TEST]').waitFor({ state: 'attached' });
      assert.equal(await page.getByRole('button', { name: '添加并初始化采集' }).isDisabled(), true);
      await selector.selectOption('AUTO_TEST');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      mkdirSync('outputs', { recursive: true }); await page.screenshot({ path: 'outputs/warehouse-discovery-mobile.png' });
      await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/warehouses') && r.request().method() === 'POST'), page.getByRole('button', { name: '添加并初始化采集' }).click()]);
      await page.getByLabel('选择仓库', { exact: true }).waitFor();
      await context.addCookies([{ name: 'inventory_session', value: tokens.existing, url }]);
      await page.goto(url + '/'); await page.getByRole('button', { name: '增加仓库', exact: true }).click();
      const dialog = page.getByRole('dialog'); await dialog.getByLabel(/选择仓库（/).locator('option[value=AUTO_TEST]').waitFor({ state: 'attached' });
      await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: 'outputs/warehouse-discovery-desktop.png' });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  }
  r = await add('fresh', { code: 'AUTO_TEST', name: '伪造名称', warehouseId: '2', source: 'jackyun', initialize: true });
  assert.equal(r.status, 200); const first = await r.json(); assert.equal(first.queued, true);
  assert.equal(first.warehouses[0].warehouseId, '999'); assert.equal(first.warehouses[0].name, '测试自动获取仓库');
  r = await add('fresh', { code: 'AUTO_TEST', source: 'jackyun', initialize: true }); assert.equal((await r.json()).job.id, first.job.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM local_jobs WHERE owner='owner-fresh'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM warehouses WHERE owner='owner-existing'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM local_jobs WHERE owner='owner-existing'").get().n, 0);
  worker = spawn(process.execPath, ['--import', pathToFileURL(resolve('tests/mock-jackyun.mjs')).href, 'build-node/worker.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stderr.on('data', d => output += d);
  let state;
  for (let i = 0; i < 80; i++) {
    state = db.prepare('SELECT state FROM local_jobs WHERE id=?').get(first.job.id)?.state;
    if (state === 'complete' || state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(state, 'complete', output + JSON.stringify(db.prepare('SELECT state,message FROM local_jobs').all()));
  r = await fetch(url + '/api/inventory?warehouseCode=AUTO_TEST', { headers: headers('fresh') });
  assert.equal(r.status, 200); const inventory = await r.json();
  assert.equal(inventory.snapshot.source, 'live'); assert.equal(inventory.rows[0].quantity, '17.25');
  assert.equal(inventory.warehouseCode, 'AUTO_TEST'); assert.equal(inventory.rows[0].goodsNo, 'TEST-GOODS');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM stock_snapshots WHERE owner='owner-existing'").get().n, 0);
  console.log('仓库列表、添加、初始化入队、worker采集、库存发布及账户隔离检查通过（模拟吉客云）');
} finally {
  if (worker?.exitCode === null) { const done = new Promise(r => worker.once('exit', r)); worker.kill(); await done; }
  if (server.exitCode === null) { const done = new Promise(r => server.once('exit', r)); server.kill(); await done; }
}
