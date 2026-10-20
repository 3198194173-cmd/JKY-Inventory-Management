import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { companyLoginEnabled, bindCompanyAccount } from '@/lib/accounts';
import { consumeDingLogin, loginConfig, loginBrowserCookie, verifyCompanyLogin } from '@/lib/dingtalk-login';
import { createSession, revokeSession, sessionCookie } from '@/lib/local-session';
import { workspaceCookie } from '@/lib/auth';
import { sessionCookieOptions } from '@/lib/session-policy';
import { platformSelectionPath } from '@/lib/platform-routing';
export async function GET(request:Request){
  const config=loginConfig(),params=new URL(request.url).searchParams;
  try{
    if(!companyLoginEnabled()||!config.ready)throw new Error('not configured');
    const browser=(await cookies()).get(loginBrowserCookie)?.value||'';
    const returnTo=consumeDingLogin(params.get('state')||'',browser);
    if(params.has('error'))throw new Error('cancelled');
    const identity=await verifyCompanyLogin(params.get('authCode')||''),account=bindCompanyAccount(identity);
    const old=(await cookies()).get(sessionCookie)?.value;if(old)revokeSession(old);
    const response=NextResponse.redirect(new URL(platformSelectionPath(returnTo),config.origin),303);
    response.cookies.set(sessionCookie,createSession(account),sessionCookieOptions(true,config.origin));
    response.cookies.delete(loginBrowserCookie);response.cookies.delete(workspaceCookie);
    response.headers.set('Cache-Control','no-store');response.headers.set('Referrer-Policy','no-referrer');return response;
  }catch{
    const response=NextResponse.redirect(new URL('/login?error=dingtalk',config.origin||request.url),303);
    response.cookies.delete(loginBrowserCookie);response.headers.set('Cache-Control','no-store');response.headers.set('Referrer-Policy','no-referrer');return response;
  }
}
