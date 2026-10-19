import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sqlite } from '../lib/sqlite.mjs';
import { bindCompanyAccount, markDeparted, manageAccount } from '../lib/accounts';
import { createSession, renewSession, revokeSession, sessionDigest } from '../lib/session-store';
import { sessionMaxAge, sessionCookieOptions, verificationRetryPath } from '../lib/session-policy';

mkdirSync('.sites-runtime/tests', { recursive: true });
Object.assign(process.env, { INVENTORY_DB_PATH: resolve(`.sites-runtime/tests/session-${randomUUID()}.sqlite`), INVENTORY_SITE_URL: 'https://inventory.example.test', INVENTORY_DINGTALK_LOGIN_ENABLED: 'true', INVENTORY_LOCAL_LOGIN_ENABLED: 'false', INVENTORY_OWNER_ID: 'session-admin', DINGTALK_CORP_ID: 'session-corp', DINGTALK_ADMIN_UNION_ID: 'union-admin' });
const person = (id: string) => ({ corpId: 'session-corp', userId: id, unionId: 'union-' + id, name: id, avatar: '' });
test('钉钉30天持久 Cookie，配置范围检查和安全返回路径；本地密码有效期保持24小时', () => {
  delete process.env.INVENTORY_SESSION_DAYS;
  assert.equal(sessionMaxAge(true), 30 * 86400); assert.equal(sessionMaxAge(false), 86400);
  assert.deepEqual(sessionCookieOptions(true, 'http://internal:3000'), { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 2592000 });
  for (const invalid of ['0', '-1', '91', '1.5', 'NaN']) { process.env.INVENTORY_SESSION_DAYS = invalid; assert.equal(sessionMaxAge(true), 2592000); }
  process.env.INVENTORY_SESSION_DAYS = '7'; assert.equal(sessionMaxAge(true), 7 * 86400); delete process.env.INVENTORY_SESSION_DAYS;
  assert.equal(verificationRetryPath('/admin/accounts?tab=a'), '/admin/accounts?tab=a');
  for (const unsafe of ['//evil.example', 'https://evil.example', '/\\evil.example', '/\nfoo']) assert.equal(verificationRetryPath(unsafe), '/');
});
test('手机/电脑独立会话与滚动续期；旧24小时会话升级且重启不依赖内存令牌', () => {
  const account = bindCompanyAccount(person('member')), db = sqlite();
  const phone = createSession(account), desktop = createSession(account), now = Date.now();
  assert.notEqual(phone, desktop); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_sessions WHERE account_id=?').get(account.id)!.n, 2);
  const original = db.prepare('SELECT * FROM account_sessions WHERE token_hash=?').get(sessionDigest(phone))!;
  assert.ok(Math.abs(Number(original.expires_at) - now - 30 * 86400000) < 1000);
  assert.notEqual(original.token_hash, phone);
  db.prepare('UPDATE account_sessions SET expires_at=? WHERE token_hash=?').run(now + 1000, sessionDigest(phone));
  const renewal = renewSession(phone, account.id)!;
  assert.equal(renewal.company, true); assert.ok(renewal.expiresAt > now + 29 * 86400000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_sessions WHERE token_hash=?').get(sessionDigest(phone))!.n, 1);
  revokeSession(phone); assert.equal(renewSession(phone, account.id), null);
  assert.ok(renewSession(desktop, account.id), '退出手机不影响电脑');
});
test('到期、伪造、跨账户和已撤销会话不能被续期；禁用/离职立即撤销', () => {
  const admin = bindCompanyAccount(person('admin')), member = bindCompanyAccount(person('revocable')), other = bindCompanyAccount(person('other')), db = sqlite();
  const expired = createSession(member), active = createSession(member);
  db.prepare('UPDATE account_sessions SET expires_at=? WHERE token_hash=?').run(Date.now() - 1, sessionDigest(expired));
  assert.equal(renewSession(expired, member.id), null); assert.equal(renewSession('fake', member.id), null); assert.equal(renewSession(active, other.id), null);
  manageAccount(admin, member.id, { status: 'disabled' }); assert.throws(() => renewSession(active, member.id), /不可用/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_sessions WHERE account_id=?').get(member.id)!.n, 0);
  const left = createSession(other); markDeparted(other.id); assert.throws(() => renewSession(left, other.id), /不可用/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_sessions WHERE account_id=?').get(other.id)!.n, 0);
});
