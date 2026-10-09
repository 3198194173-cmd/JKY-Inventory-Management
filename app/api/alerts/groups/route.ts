import { assertSameOrigin, currentOwner, errorResponse } from "@/lib/auth";
import { syncRobotGroups, groupState } from "@/lib/dingtalk-groups-store";
import { requireWarehouse } from "@/lib/inventory-store";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const owner=await currentOwner(),code=new URL(request.url).searchParams.get("warehouseCode")||"CK031";
    await requireWarehouse(owner,code);
    await syncRobotGroups(owner,{force:true});
    return Response.json(groupState(owner,code),{headers:{"Cache-Control":"no-store"}});
  } catch (error) { return errorResponse(error); }
}
