import { assertSameOrigin,currentOwner,errorResponse } from "@/lib/auth";
import { saveCollectionSchedule } from "@/lib/alerts-store";

export async function POST(request:Request) {
  try {
    assertSameOrigin(request);
    const body=await request.json() as Record<string,unknown>;
    return Response.json(await saveCollectionSchedule(await currentOwner(),body.warehouseCode,body.dailyTime));
  } catch(error){return errorResponse(error);}
}
