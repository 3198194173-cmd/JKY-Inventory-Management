import { currentOwner, errorResponse } from "@/lib/auth";
import { previewTurnoverAlert } from "@/lib/alerts-store";
import { renderTurnoverCard } from "@/lib/dingtalk-card-image";

export async function GET(request: Request) {
  try {
    const owner = await currentOwner(), params = new URL(request.url).searchParams;
    const preview = await previewTurnoverAlert(owner,params.get("warehouseCode") || "CK031",params.get("averageThreshold") ?? undefined);
    if (params.get("format") === "image") {
      const part = Number(params.get("part") || "1");
      if (!Number.isInteger(part) || part < 1 || part > preview.cards.length) return Response.json({error:"卡片页码无效"},{status:400});
      return new Response(new Uint8Array(await renderTurnoverCard(preview.cards[part-1])),{headers:{"Content-Type":"image/png","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
    }
    return Response.json(preview,{headers:{"Cache-Control":"no-store"}});
  } catch (error) { return errorResponse(error); }
}
