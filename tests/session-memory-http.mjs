import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { sqlite } from '../lib/sqlite.mjs';

mkdirSync('.sites-runtime/tests', { recursive: true });
const suffix = Date.now();
process.env.INVENTORY_DB_PATH = resolve(`.sites-runtime/tests/session-http-${suffix}.sqlite`);
const stateFile = resolve(`.sites-runtime/tests/session-identity-${suffix}.txt`);
writeFileSync(stateFile, 'member');
const db = sqlite(), now = Date.now(), date = new Date(now).toISOString();
db.prepare("INSERT INTO accounts(id,data_owner,provider,corp_id,dingtalk_user_id,union_id,display_name,role,member_state,membership_checked_at,created_at,updated_at) VALUES('member','session-owner','dingtalk','test-corp','member','union-member','测试成员','member','verified',?,?,?)").run(now, date, date);
const phone = randomBytes(32).toString('hex'), desktop = randomBytes(32).toString('hex');
const hash = token => createHash('sha256').update(token).digest('hex');
for (const token of [phone, desktop]) db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?)').run(hash(token), 'member', now + 3600000, now - 23 * 3600000);
cpSync('drizzle', '.next/standalone/drizzle', { recursive: true }); cpSync('public', '.next/standalone/public', { recursive: true }); cpSync('.next/static', '.next/standalone/.next/static', { recursive: true });
const url = 'http://127.0.0.1:3196', origin = 'https://inventory.example.test';
const env = { ...process.env, PORT: '3196', HOSTNAME: '127.0.0.1', INVENTORY_SITE_URL: origin, INVENTORY_DINGTALK_LOGIN_ENABLED: 'true', INVENTORY_LOCAL_LOGIN_ENABLED: 'false', INVENTORY_SESSION_DAYS: '30', DINGTALK_CORP_ID: 'test-corp', DINGTALK_ADMIN_UNION_ID: 'union-admin', DINGTALK_LOGIN_CLIENT_ID: 'offline-app', DINGTALK_LOGIN_CLIENT_SECRET: 'offline-test-only', MOCK_IDENTITY_STATE_PATH: stateFile, JACKYUN_APP_SECRET: '', DINGTALK_CLIENT_SECRET: '', INVENTORY_SCHEDULE_ENABLED: 'false' };
let server, output = '';
const headers = token => ({ cookie: 'inventory_session=' + token, origin });
async function start() {
  server = spawn(process.execPath, ['--import', pathToFileURL(resolve('tests/mock-session-identity.mjs')).href, '.next/standalone/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => output += d); server.stderr.on('data', d => output += d);
  for (let i = 0; i < 80; i++) { try { if ((await fetch(url + '/api/health')).ok) return; } catch {} if (server.exitCode !== null) break; await new Promise(r => setTimeout(r, 150)); }
  throw new Error('Session test server not ready: ' + output);
}
async function stop() { if (server?.exitCode === null) { const done = new Promise(r => server.once('exit', r)); server.kill(); await done; } }
const renew = token => fetch(url + '/api/session', { method: 'PATCH', headers: headers(token) });
try {
  await start();
  let r = await fetch(url + '/api/session', { method: 'PATCH', headers: { origin } }); assert.equal(r.status, 401);
  r = await fetch(url + '/api/session', { method: 'PATCH', headers: { ...headers(phone), origin: 'https://evil.example' } }); assert.equal(r.status, 400);
  r = await renew(phone); assert.equal(r.status, 200, output);
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /Max-Age=2592000/i); assert.match(cookie, /HttpOnly/i); assert.match(cookie, /Secure/i); assert.match(cookie, /SameSite=lax/i);
  assert.match(cookie, new RegExp('inventory_session=' + phone));
  assert.ok(Date.parse((await r.json()).expiresAt) > now + 29 * 86400000);
  assert.equal(db.prepare('SELECT expires_at FROM account_sessions WHERE token_hash=?').get(hash(desktop)).expires_at, now + 3600000, '续期手机不修改电脑会话');
  // A stale/invalid admin workspace selection must not invalidate actor login.
  r = await fetch(url + '/api/session', { method: 'PATCH', headers: { ...headers(phone), cookie: 'inventory_session=' + phone + '; inventory_workspace=missing-target' } }); assert.equal(r.status, 200);
  await stop(); await start();
  r = await fetch(url + '/api/session', { headers: headers(phone) }); assert.equal(r.status, 200, '服务器重启后沿用持久会话');
  writeFileSync(stateFile, 'unavailable'); db.prepare("UPDATE accounts SET membership_checked_at=0 WHERE id='member'").run();
  const before = db.prepare('SELECT expires_at FROM account_sessions WHERE token_hash=?').get(hash(phone)).expires_at;
  r = await renew(phone); assert.equal(r.status, 503); assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(db.prepare('SELECT expires_at FROM account_sessions WHERE token_hash=?').get(hash(phone)).expires_at, before, '核验失败不续期、不删除、不放行业务数据');
  r = await fetch(url + '/', { headers: headers(phone), redirect: 'manual' }); assert.equal(r.status, 307); assert.match(r.headers.get('location'), /verification_unavailable/);
  r = await fetch(url + '/login?error=verification_unavailable&returnTo=%2F', { headers: headers(phone) });
  const retry = await r.text(); assert.match(retry, /重试验证/); assert.match(retry, /无需重新扫码/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n, 2);
  writeFileSync(stateFile, 'member'); r = await renew(phone); assert.equal(r.status, 200, '钉钉恢复后旧Cookie直接恢复使用');
  r = await fetch(url + '/', { headers: headers(phone), redirect: 'manual' }); assert.equal(r.status, 200);
  console.log('PASS: 会话续期、服务重启、核验故障和恢复接口检查');
  if (process.env.TEST_BROWSER === 'true') {
    const { chromium } = await import('file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
      async function proxy(context) {
        context.setDefaultTimeout(10000);
        await context.route(origin + '/**', async route => {
          const target = new URL(route.request().url());
          const response = await route.fetch({ url: url + target.pathname + target.search, headers: { ...await route.request().allHeaders(), origin }, maxRedirects: 0, timeout: 10000 });
          await route.fulfill({ response });
        });
      }
      for (const [width, token] of [[390, phone], [1440, desktop]]) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        await proxy(context);
        await context.addCookies([{ name: 'inventory_session', value: token, url: origin }]);
        const page = await context.newPage();
        const renewal = page.waitForResponse(response => response.url().endsWith('/api/session') && response.request().method() === 'PATCH');
        await page.goto(origin + '/'); const refreshed = await renewal; assert.equal(refreshed.status(), 200);
        const saved = (await context.cookies()).find(c => c.name === 'inventory_session');
        assert.ok(saved.expires * 1000 > now + 29 * 86400000); assert.equal(saved.httpOnly, true);
        const storage = await context.storageState(); await context.close();
        const reopened = await browser.newContext({ storageState: storage, viewport: { width, height: 900 } });
        await proxy(reopened);
        const again = await reopened.newPage();
        const restored = again.waitForResponse(response => response.url().endsWith('/api/session') && response.request().method() === 'PATCH');
        await again.goto(origin + '/'); await again.getByRole('heading', { name: '选择你的第一个仓库' }).waitFor(); assert.equal((await restored).status(), 200);
        assert.equal(await again.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await reopened.close();
        console.log(`PASS: ${width}px 浏览器持久Cookie和关闭后恢复登录`);
      }
    } finally { await browser.close(); }
  }
  r = await fetch(url + '/api/session', { method: 'DELETE', headers: headers(phone) }); assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie'), /Max-Age=0|Expires=/i);
  assert.equal((await renew(phone)).status, 401); assert.equal((await renew(desktop)).status, 200);
  db.prepare("UPDATE accounts SET membership_checked_at=0 WHERE id='member'").run(); writeFileSync(stateFile, 'departed');
  r = await renew(desktop); assert.equal(r.status, 403); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n, 0);
  console.log('PASS: 30天Cookie续期、双端独立、重启保留、503重试恢复、退出/离职撤销与CSRF（模拟钉钉）');
} finally { await stop(); }
