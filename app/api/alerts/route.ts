import { assertSameOrigin, currentOwner, errorResponse } from "@/lib/auth";
import { settings, saveSettings } from "@/lib/alerts-store";

export async function GET() {
  try { return Response.json(await settings(await currentOwner()), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const owner = await currentOwner(), body = await request.json() as { enabled?: unknown; threshold?: unknown };
    if (typeof body.enabled !== "boolean") throw new Error("预警开关参数无效");
    return Response.json(await saveSettings(owner, body.enabled, body.threshold));
  } catch (error) { return errorResponse(error); }
}
