import { getChatGPTUser } from "@/app/chatgpt-auth";

export async function currentOwner(): Promise<string> {
  const user = await getChatGPTUser();
  if (!user) throw new Error("请先登录后使用库存数据");
  return user.userId;
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) throw new Error("请求来源不匹配");
}

export function errorResponse(error: unknown, status = 400) {
  return Response.json({ error: error instanceof Error ? error.message : "操作失败，请重试" }, { status, headers: { "Cache-Control": "no-store" } });
}
