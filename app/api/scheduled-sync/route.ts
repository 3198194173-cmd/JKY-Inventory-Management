import { env } from "cloudflare:workers";
import { createHash, timingSafeEqual } from "node:crypto";
import { database, loadInventory, loadRuns } from "@/lib/inventory-store";
import { syncWarehouse } from "@/lib/sync-warehouse";
import { shanghaiTimestamp } from "@/lib/jackyun";
import { errorResponse } from "@/lib/auth";

// Private Site dispatch authenticates non-user callers. The application secret
// also protects this writer after migration to the user's server/domain.
function authorized(request: Request): boolean {
  const secret = env.INVENTORY_CRON_SECRET, supplied = request.headers.get("authorization") || "";
  if (!secret || secret.length < 32 || supplied.length > 512) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(supplied), digest(`Bearer ${secret}`));
}
type Target = { owner: string; code: string };
async function targets(): Promise<Target[]> {
  return (await database().prepare("SELECT owner, code FROM warehouses WHERE schedule_enabled = 1 ORDER BY owner, code").all<Target>()).results;
}
export async function POST(request: Request) {
  if (!authorized(request)) return errorResponse(new Error("自动采集认证失败"), 401);
  try {
    const now = shanghaiTimestamp(), date = now.slice(0,10);
    if (now.slice(11) < "08:00:00") return Response.json({date, skipped:true, reason:"尚未到北京时间08:00"});
    const results = [];
    for (const target of await targets()) {
      // Registered owners/warehouses are server-side data; callers cannot choose another user's identity.
      const done = await database().prepare("SELECT snapshot_id FROM daily_slots WHERE owner = ? AND warehouse_code = ? AND date = ?").bind(target.owner,target.code,date).first();
      if (done) { results.push({warehouseCode:target.code, status:"already_complete"}); continue; }
      try { results.push({ ...await syncWarehouse(target.owner,target.code,"daily"), status:"complete" }); }
      catch(error) { results.push({warehouseCode:target.code,status:"failed",error:error instanceof Error ? error.message : "采集失败"}); }
    }
    return Response.json({date,results}, {headers:{"Cache-Control":"no-store"}});
  } catch(error) { return errorResponse(error); }
}
export async function GET(request: Request) {
  if (!authorized(request)) return errorResponse(new Error("自动采集认证失败"), 401);
  try {
    const results = [];
    for (const target of await targets()) {
      const view = await loadInventory(target.owner,{warehouseCode:target.code});
      results.push({warehouseCode:target.code,snapshot:view.snapshot,goodsCount:view.goodsCount,salesDates:view.salesDates,runs:await loadRuns(target.owner,target.code)});
    }
    return Response.json({results}, {headers:{"Cache-Control":"no-store"}});
  } catch(error) { return errorResponse(error); }
}
