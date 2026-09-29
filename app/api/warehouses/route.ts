import { assertSameOrigin, currentOwner, errorResponse } from "@/lib/auth";
import { addWarehouse, loadWarehouses } from "@/lib/inventory-store";
export async function GET() {
  try { return Response.json(await loadWarehouses(await currentOwner()), { headers: { "Cache-Control": "no-store" } }); } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const owner = await currentOwner(), input = await request.json() as { code?: unknown; name?: unknown };
    return Response.json(await addWarehouse(owner, input.code, input.name));
  } catch (error) { return errorResponse(error); }
}
