import { NextResponse } from 'next/server';
import { beginDingLogin, loginBrowserCookie } from '@/lib/dingtalk-login';
import { errorResponse } from '@/lib/auth';
export async function GET(request:Request){
  try{
    const {url,browser}=beginDingLogin(new URL(request.url).searchParams.get('returnTo')||'/');
    const response=NextResponse.redirect(url,303);
    response.headers.set('Cache-Control','no-store');response.headers.set('Referrer-Policy','no-referrer');
    response.cookies.set(loginBrowserCookie,browser,{httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:300});
    return response;
  }catch(e){return errorResponse(e);}
}
