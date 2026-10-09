import { acquireRun, completeInventoryRun, failRun, inboundRunProgress, publishSnapshot, requireWarehouse, updateRun } from "./inventory-store";
import { reconcileWarehouseInbound } from "./inbound-store";
import { collectWarehouseStock } from "./warehouse-collector";
import { serverConfig } from "./server-config";
import { syncTransit } from './transit-store';

export async function syncWarehouse(owner: string, code: string, trigger = "manual", existingRunId?: string) {
  const registered = await requireWarehouse(owner, code);
  const config = serverConfig();
  if (!config.configured) throw new Error("尚未配置吉客云 AppSecret，请先完成服务端配置");
  const id = existingRunId || await acquireRun(owner, code, trigger);
  try {
    const result = await collectWarehouseStock(config.appkey, config.secret, code, (pages, records, goods) => updateRun(id, pages, records, goods), undefined, undefined, registered.warehouseId, true);
    const scope = {key:result.scope.key,label:result.scope.label,count:result.catalog.rows.length};
    const captured = await publishSnapshot(owner, id, result.rows, result.pageCount, result.recordCount, result.duplicateCount, scope, result.catalog, result.unavailable, true);
    let inboundMessage: string;
    try {
      const inbound = await reconcileWarehouseInbound(owner, code, config.appkey, config.secret, (done,total,requests) => inboundRunProgress(id,done,total,requests), undefined, id);
      inboundMessage = inbound.checked ? `仓库入库核验 ${inbound.windows} 个区间、${inbound.checked} 个货品区间：已核算 ${inbound.verified}，未解释 ${inbound.unresolved}，查询失败 ${inbound.failed}（详情中列出）` : "无需新增入库核验";
    } catch { inboundMessage = "库存已保存；入库核验未完成，请再次采集重试，未核验日期不计算销量"; }
    const transitMessage=await syncTransit(owner,code,id,config.appkey,config.secret,async requests=>{
      const {database}=await import('./inventory-store');
      await database().prepare("UPDATE sync_runs SET last_progress_at=?,message=? WHERE id=? AND status='running'").bind(new Date().toISOString(),`库存已保存；正在核验申请在途，已请求 ${requests} 次`,id).run();
    });
    const message = `已核验 ${result.recordCount} 个规格、${result.rows.length} 个货品；${result.unavailable.length ? `${result.unavailable.length} 个规格未取得库存，已列出；` : ""}${inboundMessage}；${transitMessage}`;
    await completeInventoryRun(id,message);
    return { id, capturedAt: captured, warehouseCode: code, goodsCount: result.rows.length, skuCount: result.catalog.rows.length, recordCount: result.recordCount, pageCount: result.pageCount, unavailableCount:result.unavailable.length, message };
  } catch (error) {
    await failRun(id, error instanceof Error ? error.message : "采集失败"); throw error;
  }
}
