import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { assertSameOrigin, currentContext, errorResponse } from '@/lib/auth';
import { createSession, revokeSession, sessionCookie, sessionUser, verifyPassword } from '@/lib/local-session';
import { sqlite } from '@/lib/sqlite.mjs';
import { AccessError, localLoginEnabled, legacyAccount, audit } from '@/lib/accounts';
import { workspaceCookie } from '@/lib/auth';
import { renewSession } from '@/lib/session-store';
import { sessionCookieOptions } from '@/lib/session-policy';

export async function GET(){
  try{const {actor,target}=await currentContext();return NextResponse.json({account:{id:actor.id,name:actor.display_name,role:actor.role},workspace:{id:target.id,name:target.display_name},managing:actor.id!==target.id},{headers:{'Cache-Control':'no-store'}});}catch(e){return errorResponse(e);}
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await sessionUser();
    if (!actor) throw new AccessError('登录已过期，请重新登录', 401);
    const token = (await cookies()).get(sessionCookie)?.value;
    const renewal = token ? renewSession(token, actor.accountId) : null;
    if (!renewal) throw new AccessError('登录已过期，请重新登录', 401);
    const response = NextResponse.json({ ok: true, expiresAt: new Date(renewal.expiresAt).toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
    response.cookies.set(sessionCookie, token!, sessionCookieOptions(renewal.company, request.url));
    return response;
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    if(!localLoginEnabled())return errorResponse(new Error('账号密码登录已关闭，请使用公司钉钉登录'),403);
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
    response.cookies.set(sessionCookie,createSession(),sessionCookieOptions(false,request.url));
    response.cookies.delete(workspaceCookie);
    const actor=legacyAccount();audit(actor.id,actor.id,'login_local');
    return response;
  } catch(error) { return errorResponse(error); }
}
export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const token = (await cookies()).get(sessionCookie)?.value;
    if (token) revokeSession(token);
    const response = NextResponse.json({ok:true}); response.cookies.delete(sessionCookie);response.cookies.delete(workspaceCookie); return response;
  } catch(error) { return errorResponse(error); }
}
