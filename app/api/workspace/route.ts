import { NextResponse } from 'next/server';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { assertSameOrigin, errorResponse, workspaceCookie } from '@/lib/auth';
import { AccessError, accountById, audit } from '@/lib/accounts';
export async function POST(request:Request){
  try{
    assertSameOrigin(request);const user=await getChatGPTUser();if(!user)throw new AccessError('请先登录',401);
    const actor=accountById(user.accountId)!;
    const body=await request.json() as Record<string,unknown>;const target=accountById(String(body.accountId||''));
    if(!target || (target.id!==actor.id&&actor.role!=='admin'))throw new AccessError('没有访问该账户的权限');
    audit(actor.id,target.id,'enter_workspace');
    const response=NextResponse.json({ok:true});
    response.cookies.set(workspaceCookie,target.id,{httpOnly:true,sameSite:'lax',secure:(process.env.INVENTORY_SITE_URL||request.url).startsWith('https:'),path:'/',maxAge:86400});return response;
  }catch(e){return errorResponse(e);}
}
export async function DELETE(request:Request){
  try{assertSameOrigin(request);const user=await getChatGPTUser();if(!user)throw new AccessError('请先登录',401);audit(user.accountId,user.accountId,'exit_workspace');const r=NextResponse.json({ok:true});r.cookies.delete(workspaceCookie);return r;}catch(e){return errorResponse(e);}
}
