import { assertSameOrigin, currentOwner, errorResponse } from "@/lib/auth";
import { settings, saveSettings } from "@/lib/alerts-store";

export async function GET(request:Request) {
  try { return Response.json(await settings(await currentOwner(),new URL(request.url).searchParams.get("warehouseCode")||"CK031"), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const owner=await currentOwner(),body=await request.json() as Record<string,unknown>;
    if(typeof body.enabled!=="boolean")throw new Error("预警开关参数无效");
    if(typeof body.warehouseCode!=="string" || !body.warehouseCode)throw new Error("请选择要设置预警的仓库");
    return Response.json(await saveSettings(owner,body.enabled,body.threshold??"0",body.turnoverAverageThreshold,body.selectedGroupIds,body.notifyTime,
      {warehouseCode:body.warehouseCode,turnoverDays:body.turnoverDays,excludedNameKeywords:body.excludedNameKeywords}),{headers:{"Cache-Control":"no-store"}});
  } catch(error){return errorResponse(error);}
}
