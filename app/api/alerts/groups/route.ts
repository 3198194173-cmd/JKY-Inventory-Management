import { assertSameOrigin, currentOwner, errorResponse } from "@/lib/auth";
import { syncRobotGroups } from "@/lib/dingtalk-groups-store";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    return Response.json(await syncRobotGroups(await currentOwner(), { force: true }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
