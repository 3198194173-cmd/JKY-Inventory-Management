import { getChatGPTUser } from "@/app/chatgpt-auth";
import { cookies } from 'next/headers';
import { AccessError, accountById, audit } from './accounts';

export const workspaceCookie='inventory_workspace';
export async function currentContext() {
  const user = await getChatGPTUser();
  if (!user) throw new AccessError("请先登录后使用库存数据",401);
  const actor=accountById(user.accountId)!;
  const id=(await cookies()).get(workspaceCookie)?.value;
  const target=id ? accountById(id) : actor;
  if(!target)throw new AccessError('目标账户不存在');
  if(target.id!==actor.id&&actor.role!=='admin')throw new AccessError('没有访问该账户的权限');
  return {actor,target};
}
export async function currentOwner(request?:Request): Promise<string> {
  const {actor,target}=await currentContext();
  if(request && !['GET','HEAD'].includes(request.method))audit(actor.id,target.id,'business_write_requested',{method:request.method,path:new URL(request.url).pathname});
  return target.data_owner;
}
export async function requireAdmin(){
  const {actor}=await currentContext();if(actor.role!=='admin')throw new AccessError('需要管理员权限');return actor;
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== (process.env.INVENTORY_SITE_URL || new URL(request.url).origin)) throw new Error("请求来源不匹配");
}

export function errorResponse(error: unknown, status = 400) {
  return Response.json({ error: error instanceof Error ? error.message : "操作失败，请重试" }, { status:error instanceof AccessError ? error.status : status, headers: { "Cache-Control": "no-store" } });
}
