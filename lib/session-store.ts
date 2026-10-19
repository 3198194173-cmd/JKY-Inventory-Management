import { createHash, randomBytes } from 'node:crypto';
import { sqlite } from './sqlite.mjs';
import { accountById, assertOwnerActive, companyLoginEnabled, legacyAccount, localLoginEnabled, type Account } from './accounts';
import { sessionMaxAge } from './session-policy';

export const sessionDigest = (value: string) => createHash('sha256').update(value).digest('hex');
export function createSession(account?: Account) {
  const token = randomBytes(32).toString('hex'), db = sqlite(), now = Date.now();
  db.prepare('DELETE FROM local_sessions WHERE expires_at<?').run(now);
  if (account) {
    assertOwnerActive(account.data_owner);
    db.prepare('DELETE FROM account_sessions WHERE expires_at<?').run(now);
    db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?)').run(sessionDigest(token), account.id, now + sessionMaxAge(true) * 1000, now);
  } else {
    if (!localLoginEnabled()) throw new Error('账号密码登录已关闭');
    const legacy = legacyAccount(); if (legacy.status !== 'active') throw new Error('账户已禁用');
    db.prepare('INSERT INTO local_sessions VALUES(?,?,?)').run(sessionDigest(token), legacy.data_owner, now + sessionMaxAge(false) * 1000);
  }
  return token;
}

// Caller must successfully authenticate and check company membership first.
// Refresh the existing device token; never insert or revive an expired session.
export function renewSession(token: string, accountId: string) {
  if (!token || token.length > 256) return null;
  const account = accountById(accountId);
  if (!account) return null;
  assertOwnerActive(account.data_owner);
  const db = sqlite(), now = Date.now(), hash = sessionDigest(token);
  if (companyLoginEnabled()) {
    const expiresAt = now + sessionMaxAge(true) * 1000;
    const renewed = db.prepare("UPDATE account_sessions SET expires_at=? WHERE token_hash=? AND account_id=? AND expires_at>? AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND status='active' AND member_state='verified') RETURNING expires_at").get(expiresAt, hash, accountId, now, accountId);
    if (renewed) return { company: true, expiresAt: Number(renewed.expires_at) };
  }
  if (localLoginEnabled()) {
    const expiresAt = now + sessionMaxAge(false) * 1000;
    const renewed = db.prepare("UPDATE local_sessions SET expires_at=? WHERE token_hash=? AND owner=? AND expires_at>? AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND status='active') RETURNING expires_at").get(expiresAt, hash, account.data_owner, now, accountId);
    if (renewed) return { company: false, expiresAt: Number(renewed.expires_at) };
  }
  return null;
}
export function revokeSession(token: string) {
  sqlite().prepare('DELETE FROM local_sessions WHERE token_hash=?').run(sessionDigest(token));
  sqlite().prepare('DELETE FROM account_sessions WHERE token_hash=?').run(sessionDigest(token));
}
