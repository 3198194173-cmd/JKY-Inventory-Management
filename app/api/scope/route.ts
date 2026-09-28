import { assertSameOrigin, currentOwner, errorResponse } from "@/lib/auth";
import { loadScope, saveScope } from "@/lib/scope-store";
import { scopeInfo } from "@/lib/stock-scope";

export async function GET() {
  try {
    const scope = await loadScope(await currentOwner());
    return Response.json(scope ? { ...scopeInfo(scope), barcodes: scope.barcodes.join("\n") } : null, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json() as { barcodes?: unknown; label?: unknown };
    return Response.json(await saveScope(await currentOwner(), body.barcodes, body.label));
  } catch (error) { return errorResponse(error); }
}
