import { assertSameOrigin, currentOwner, errorResponse } from "@/lib/auth";
import { ManualAlertError, sendManualAlert } from "@/lib/manual-alerts";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const owner = await currentOwner();
    return Response.json(await sendManualAlert(owner, await request.json()), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error, error instanceof ManualAlertError ? error.status : 400); }
}
