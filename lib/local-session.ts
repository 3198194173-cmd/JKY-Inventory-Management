import { cookies } from 'next/headers';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { sqlite } from './sqlite.mjs';
import { accountById, legacyAccount, localLoginEnabled, companyLoginEnabled, type Account } from './accounts';
import { ensureOwnerAccess } from './dingtalk-login';

export const sessionCookie = 'inventory_session';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function verifyPassword(password: string) {
  const [salt, expected] = (process.env.INVENTORY_PASSWORD_HASH || '').split(':');
  if (!salt || !/^[a-f0-9]{128}$/.test(expected || '') || password.length > 1024) return false;
  return timingSafeEqual(scryptSync(password,salt,64),Buffer.from(expected,'hex'));
}
export async function sessionUser() {
  const token = (await cookies()).get(sessionCookie)?.value;
  if (!token || token.length > 256) return null;
  const session=companyLoginEnabled()?sqlite().prepare('SELECT account_id FROM account_sessions WHERE token_hash=? AND expires_at>?').get(digest(token),Date.now()):null;
  let account:Account|undefined;
  if(session)account=accountById(String(session.account_id));
  else if(localLoginEnabled()){
    const row=sqlite().prepare('SELECT owner FROM local_sessions WHERE token_hash=? AND expires_at>?').get(digest(token),Date.now());
    if(row && String(row.owner)===(process.env.INVENTORY_OWNER_ID||'admin'))account=legacyAccount();
  }
  if(!account||account.status!=='active')return null;
  await ensureOwnerAccess(account.data_owner);
  return {userId:account.data_owner,accountId:account.id,displayName:account.display_name,avatar:account.avatar_url,role:account.role,email:'',fullName:null};
}
export function createSession(account?:Account) {
  const token = randomBytes(32).toString('hex');
  sqlite().prepare('DELETE FROM local_sessions WHERE expires_at<?').run(Date.now());
  if(account){
    sqlite().prepare('DELETE FROM account_sessions WHERE expires_at<?').run(Date.now());
    sqlite().prepare('INSERT INTO account_sessions VALUES(?,?,?,?)').run(digest(token),account.id,Date.now()+86400000,Date.now());
  }else{
    if(!localLoginEnabled())throw new Error('账号密码登录已关闭');
    const legacy=legacyAccount();if(legacy.status!=='active')throw new Error('账户已禁用');
    sqlite().prepare('INSERT INTO local_sessions VALUES(?,?,?)').run(digest(token),legacy.data_owner,Date.now()+86400000);
  }
  return token;
}
export function revokeSession(token: string) { sqlite().prepare('DELETE FROM local_sessions WHERE token_hash=?').run(digest(token));sqlite().prepare('DELETE FROM account_sessions WHERE token_hash=?').run(digest(token)); }
