import { assertSameOrigin, currentOwner, errorResponse } from "@/lib/auth";
import { loadRuns, warehouseCode } from "@/lib/inventory-store";
import { enqueue } from "@/lib/local-jobs";
import { requireWarehouse } from "@/lib/inventory-store";
import { sqlite } from "@/lib/sqlite.mjs";

export async function GET(request: Request) {
  try {
    const owner = await currentOwner(), code = warehouseCode(new URL(request.url).searchParams.get("warehouseCode") || "CK031");
    const runs = await loadRuns(owner,code);
    const queued = sqlite().prepare("SELECT id,created_at AS startedAt,updated_at AS lastProgressAt,warehouse_code AS warehouseCode,message,state FROM local_jobs WHERE owner=? AND warehouse_code=? AND run_id IS NULL ORDER BY created_at DESC LIMIT 20").all(owner,code).map((j: Record<string,unknown>)=>({...j,status:j.state,pageCount:0,recordCount:0,goodsCount:0,completedAt:null}));
    return Response.json({runs:[...queued,...runs].sort((a,b)=>String(b.startedAt).localeCompare(String(a.startedAt))).slice(0,20)}, {headers:{"Cache-Control":"no-store"}});
  }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const owner = await currentOwner(), input = await request.json() as { warehouseCode?: unknown };
    const code = warehouseCode(input.warehouseCode || "CK031");
    await requireWarehouse(owner,code);
    return Response.json({queued:true,job:enqueue(owner,code)}, {status:202});
  } catch (error) { return errorResponse(error); }
}
