import { assertSameOrigin, currentOwner, errorResponse } from "@/lib/auth";
import { acquireRun, updateRun, publishSnapshot, failRun, loadRuns } from "@/lib/inventory-store";
import { collectStock } from "@/lib/jackyun";
import { serverConfig } from "@/lib/server-config";
import { notifyAfterSnapshot } from "@/lib/alerts-store";
import { loadScope } from "@/lib/scope-store";
import { scopeInfo } from "@/lib/stock-scope";

export async function GET() {
  try { return Response.json({ runs: await loadRuns(await currentOwner()) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  let id: string | undefined;
  try {
    assertSameOrigin(request);
    const owner = await currentOwner(), config = serverConfig();
    if (!config.configured) throw new Error("尚未配置吉客云 AppSecret，请先完成服务端配置");
    const scope = await loadScope(owner);
    if (!scope) throw new Error("请先设置采集范围，粘贴该仓库的完整条码清单");
    id = await acquireRun(owner);
    const result = await collectStock(config.appkey, config.secret, (pages, records, goods) => updateRun(id!, pages, records, goods), undefined, scope);
    const captured = await publishSnapshot(owner, id, result.rows, result.pageCount, result.recordCount, result.duplicateCount, scopeInfo(scope));
    // Alert failure does not invalidate a complete stock snapshot.
    try { await notifyAfterSnapshot(owner, result.rows, captured, scope.label, scope.key); } catch { /* settings failure is visible separately */ }
    return Response.json({ id, goodsCount: result.rows.length, recordCount: result.recordCount, pageCount: result.pageCount });
  } catch (error) {
    if (id) await failRun(id, error instanceof Error ? error.message : "采集失败");
    return errorResponse(error);
  }
}
