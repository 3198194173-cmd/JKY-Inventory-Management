import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { assertSameOrigin, errorResponse } from '@/lib/auth';
import { createSession, revokeSession, sessionCookie, verifyPassword } from '@/lib/local-session';
import { sqlite } from '@/lib/sqlite.mjs';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    if (Number(request.headers.get('content-length') || 0) > 8192) return errorResponse(new Error('请求过大'),413);
    const data = await request.formData(), username = String(data.get('username') || ''), password = String(data.get('password') || '');
    const account = process.env.INVENTORY_USERNAME || 'admin', now = Date.now(), db = sqlite();
    // One shared account bucket: forwarded headers cannot bypass the throttle.
    const attempt = db.prepare('SELECT count,reset_at FROM local_login_attempts WHERE username=?').get(account);
    if (attempt && Number(attempt.reset_at)>now && Number(attempt.count)>=10) return NextResponse.redirect(new URL('/login?error=1',process.env.INVENTORY_SITE_URL || request.url),303);
    db.prepare('INSERT INTO local_login_attempts VALUES(?,1,?) ON CONFLICT(username) DO UPDATE SET count=CASE WHEN reset_at<? THEN 1 ELSE count+1 END,reset_at=CASE WHEN reset_at<? THEN excluded.reset_at ELSE reset_at END').run(account,now+900000,now,now);
    if (username !== account || !verifyPassword(password)) return NextResponse.redirect(new URL('/login?error=1',process.env.INVENTORY_SITE_URL || request.url),303);
    db.prepare('DELETE FROM local_login_attempts WHERE username=?').run(account);
    const old = (await cookies()).get(sessionCookie)?.value;
    if (old) revokeSession(old);
    const response = NextResponse.redirect(new URL('/',process.env.INVENTORY_SITE_URL || request.url),303);
    response.cookies.set(sessionCookie,createSession(),{httpOnly:true,sameSite:'strict',secure:(process.env.INVENTORY_SITE_URL || request.url).startsWith('https:'),path:'/',maxAge:86400});
    return response;
  } catch(error) { return errorResponse(error); }
}
export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const token = (await cookies()).get(sessionCookie)?.value;
    if (token) revokeSession(token);
    const response = NextResponse.json({ok:true}); response.cookies.delete(sessionCookie); return response;
  } catch(error) { return errorResponse(error); }
}
