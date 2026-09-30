import { acquireRun, failRun, publishSnapshot, requireWarehouse, updateRun } from "./inventory-store";
import { collectWarehouseStock } from "./warehouse-collector";
import { serverConfig } from "./server-config";
import { notifyAfterSnapshot } from "./alerts-store";

export async function syncWarehouse(owner: string, code: string, trigger = "manual", existingRunId?: string) {
  const registered = await requireWarehouse(owner, code);
  const config = serverConfig();
  if (!config.configured) throw new Error("尚未配置吉客云 AppSecret，请先完成服务端配置");
  const id = existingRunId || await acquireRun(owner, code, trigger);
  try {
    const result = await collectWarehouseStock(config.appkey, config.secret, code, (pages, records, goods) => updateRun(id, pages, records, goods), undefined, undefined, registered.warehouseId, true);
    const scope = {key:result.scope.key,label:result.scope.label,count:result.catalog.rows.length};
    const captured = await publishSnapshot(owner, id, result.rows, result.pageCount, result.recordCount, result.duplicateCount, scope, result.catalog, result.unavailable);
    if (!result.unavailable.length) { try { await notifyAfterSnapshot(owner, result.rows, captured, `${result.catalog.name}（${code}）`, code); } catch { /* Saved inventory remains valid if alert delivery fails. */ } }
    return { id, capturedAt: captured, warehouseCode: code, goodsCount: result.rows.length, skuCount: result.catalog.rows.length, recordCount: result.recordCount, pageCount: result.pageCount, unavailableCount:result.unavailable.length };
  } catch (error) {
    await failRun(id, error instanceof Error ? error.message : "采集失败"); throw error;
  }
}
