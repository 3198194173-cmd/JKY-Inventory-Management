import { currentOwner, errorResponse } from "@/lib/auth";
import { loadSalesCalendar } from "@/lib/sales-calendar-store";

export async function GET(request: Request) {
  try {
    const owner = await currentOwner(), p = new URL(request.url).searchParams;
    const data = await loadSalesCalendar(owner,p.get("warehouseCode") || "CK031",p.get("goodsNo") || "",p.get("month") || "");
    return Response.json(data,{headers:{"Cache-Control":"no-store"}});
  } catch(error) { return errorResponse(error); }
}
