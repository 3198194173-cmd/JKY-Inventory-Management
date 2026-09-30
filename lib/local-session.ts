import { cookies } from 'next/headers';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { sqlite } from './sqlite.mjs';

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
  const row = sqlite().prepare('SELECT owner FROM local_sessions WHERE token_hash=? AND expires_at>?').get(digest(token),Date.now());
  return row ? {userId:String(row.owner),displayName:process.env.INVENTORY_USERNAME || 'admin',email:'',fullName:null} : null;
}
export function createSession() {
  const token = randomBytes(32).toString('hex');
  sqlite().prepare('DELETE FROM local_sessions WHERE expires_at<?').run(Date.now());
  sqlite().prepare('INSERT INTO local_sessions VALUES(?,?,?)').run(digest(token),process.env.INVENTORY_OWNER_ID || 'admin',Date.now()+86400000);
  return token;
}
export function revokeSession(token: string) { sqlite().prepare('DELETE FROM local_sessions WHERE token_hash=?').run(digest(token)); }
