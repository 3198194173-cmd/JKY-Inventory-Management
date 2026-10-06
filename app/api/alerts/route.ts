import { assertSameOrigin, currentOwner, errorResponse } from "@/lib/auth";
import { settings, saveSettings } from "@/lib/alerts-store";

export async function GET() {
  try { return Response.json(await settings(await currentOwner()), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const owner = await currentOwner(), body = await request.json() as { enabled?: unknown; threshold?: unknown; turnoverAverageThreshold?: unknown; selectedGroupIds?: unknown; notifyTime?: unknown; warehouseCode?: unknown; dailyTime?: unknown };
    if (typeof body.enabled !== "boolean") throw new Error("预警开关参数无效");
    const collection = body.warehouseCode !== undefined || body.dailyTime !== undefined ? { warehouseCode: body.warehouseCode, dailyTime: body.dailyTime } : undefined;
    return Response.json(await saveSettings(owner, body.enabled, body.threshold, body.turnoverAverageThreshold, body.selectedGroupIds, body.notifyTime, collection), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
