import { assertSameOrigin, currentOwner, errorResponse } from "@/lib/auth";
import { loadRuns, warehouseCode } from "@/lib/inventory-store";
import { syncWarehouse } from "@/lib/sync-warehouse";

export async function GET(request: Request) {
  try { return Response.json({ runs: await loadRuns(await currentOwner(), warehouseCode(new URL(request.url).searchParams.get("warehouseCode") || "CK031")) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const owner = await currentOwner(), input = await request.json() as { warehouseCode?: unknown };
    return Response.json(await syncWarehouse(owner, warehouseCode(input.warehouseCode || "CK031")));
  } catch (error) { return errorResponse(error); }
}
