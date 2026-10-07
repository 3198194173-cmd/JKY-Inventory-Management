import { currentOwner, errorResponse } from "@/lib/auth";
import { loadInventory } from "@/lib/inventory-store";

export async function GET(request: Request) {
  try {
    const owner = await currentOwner(), p = new URL(request.url).searchParams;
    const days = [7,14,30].includes(Number(p.get("days"))) ? Number(p.get("days")) : 14;
    const page = Math.max(1, Math.min(2000, Number(p.get("page")) || 1));
    const data = await loadInventory(owner, { compact: true, warehouseCode: p.get("warehouseCode") || "CK031", q: (p.get("q") || "").slice(0,100), filter: p.get("filter") || "all", days, page: Math.floor(page), pageSize: Number(p.get("pageSize")) || 100, sort: p.get("sort") || "quantity_desc", sortDate: p.get("sortDate") || "" });
    // The monthly detail endpoint loads documents on demand; avoid transferring
    // every receipt and duplicate stock history for a 1,000-row main table.
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
