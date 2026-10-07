import { currentOwner, errorResponse } from "@/lib/auth";
import { previewTurnoverAlert } from "@/lib/alerts-store";

export async function GET(request: Request) {
  try {
    const owner = await currentOwner(), params = new URL(request.url).searchParams;
    const preview = await previewTurnoverAlert(owner,params.get("warehouseCode") || "CK031",params.get("averageThreshold") ?? undefined);
    return Response.json(preview,{headers:{"Cache-Control":"no-store"}});
  } catch (error) { return errorResponse(error); }
}
