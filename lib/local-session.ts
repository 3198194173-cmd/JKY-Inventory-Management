import { cookies } from 'next/headers';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import { sqlite } from './sqlite.mjs';
import { accountById, legacyAccount, localLoginEnabled, companyLoginEnabled, type Account } from './accounts';
import { ensureOwnerAccess } from './dingtalk-login';
import { sessionDigest as digest } from './session-store';
export { createSession, revokeSession } from './session-store';

export const sessionCookie = 'inventory_session';
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
