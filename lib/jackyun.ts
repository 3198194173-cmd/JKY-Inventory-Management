import { createHash } from "node:crypto";
import { accumulatePage, aggregatedRows, createAccumulator } from "./stock-aggregation";
import type { StockRow } from "./inventory-types";
import { parseLosslessJson } from "./lossless-json";
import { barcodeBatches, type StockScope } from "./stock-scope";

export const WAREHOUSE_CODE = "CK031";
export const WAREHOUSE_NAME = "易速菲泰国8仓成品仓";
export const GATEWAY = "https://open.jackyun.com/open/openapi/do";
// Verified against this application's gateway response: subCode 0130020327 caps pages at 200.
export const STOCK_PAGE_SIZE = 200;

export function jackyunSign(params: Record<string, string>, secret: string): string {
  const canonical = Object.keys(params).filter(k => !["sign", "token", "contextid"].includes(k)).sort().map(k => k + params[k]).join("");
  return createHash("md5").update((secret + canonical + secret).toLowerCase(), "utf8").digest("hex");
}

export function shanghaiTimestamp(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date);
  return parts.replace("T", " ");
}

export class ApiFailure extends Error {}

export async function fetchStockPage(appkey: string, secret: string, pageIndex: number, fetcher: typeof fetch = fetch, barcodes: string[] = [], warehouseCode = WAREHOUSE_CODE, goodsNo = ""): Promise<Record<string, unknown>[]> {
  const bizcontent = JSON.stringify({ pageIndex, pageSize: STOCK_PAGE_SIZE, warehouseCode, goodsNo, goodsName: "", skuName: "", skuBarcode: barcodes.join(","), skuCode: "", cols: "warehouseName,orderAbleQuantity" });
  for (let attempt = 0; attempt < 3; attempt++) {
    const params = { appkey, bizcontent, contenttype: "json", method: "erp-stock.stock.skulist", timestamp: shanghaiTimestamp(), version: "v1.0" };
    let response: Response;
    try {
      response = await fetcher(GATEWAY, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: new URLSearchParams({ ...params, sign: jackyunSign(params, secret) }), signal: AbortSignal.timeout(25_000) });
    } catch {
      if (attempt < 2) { await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt)); continue; }
      throw new ApiFailure(`第 ${pageIndex + 1} 页网络超时或连接失败`);
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 2) { await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt)); continue; }
    if (!response.ok) throw new ApiFailure(`第 ${pageIndex + 1} 页请求失败（HTTP ${response.status}）`);
    let body: { code?: unknown; subCode?: unknown; result?: { data?: unknown; noPrivilegeItem?: unknown } };
    try { body = parseLosslessJson(await response.text()) as typeof body; } catch { throw new ApiFailure("吉客云返回的内容不是有效 JSON"); }
    // Do not echo remote error text: it can contain signed request parameters.
    if (Number(body.code) !== 200) {
      const code=String(body.subCode ?? body.code).replace(/[^\w-]/g, "").slice(0,30);
      if(code === "0130020327") throw new ApiFailure("吉客云限制每页最多 200 条，本次分页参数超出上限");
      if(code === "0250019301") throw new ApiFailure("吉客云限制条码查询参数最多 1000 字符，请缩小条码批次");
      throw new ApiFailure(`吉客云业务请求失败（错误码 ${code}），请检查应用权限与本机配置`);
    }
    const data = body.result?.data;
    const privilege = body.result?.noPrivilegeItem;
    if (privilege != null && JSON.stringify(privilege) !== "[]" && JSON.stringify(privilege) !== "{}" && privilege !== "") throw new ApiFailure("库存响应包含权限受限字段，本次未发布");
    // Live exact-match queries return success/null beyond their last page. Only
    // an explicit barcode scope may use this form; collectStock verifies every
    // requested barcode before publishing, so a short/default range cannot pass.
    if ((barcodes.length || goodsNo) && data === null && String(body.subCode) === "0250000004") return [];
    if (!Array.isArray(data) || data.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new ApiFailure("库存响应缺少有效 result.data 数组");
    return data as Record<string, unknown>[];
  }
  throw new ApiFailure("库存请求失败");
}

export async function collectStock(appkey: string, secret: string, onPage: (pages: number, records: number, goods: number) => Promise<void>, pageFetcher = fetchStockPage, scope?: StockScope, warehouse = { code: WAREHOUSE_CODE, name: WAREHOUSE_NAME, id: "2391620541187785472" }, verifyRow?: (row: Record<string, unknown>) => void, state = createAccumulator(), allowMissing = false): Promise<{ rows: StockRow[]; pageCount: number; recordCount: number; duplicateCount: number }> {
  if (!scope?.barcodes.length) throw new ApiFailure("请先设置完整条码清单；仅按仓库查询已证实会漏数据");
  let pageCount = 0;
  for (const batch of barcodeBatches(scope)) {
    const expected = new Set(batch), seen = new Set<string>();
    let ended = false;
    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
      const rows = await pageFetcher(appkey, secret, pageIndex, fetch, batch, warehouse.code);
      pageCount++;
      if (rows.length > STOCK_PAGE_SIZE) throw new ApiFailure("接口返回数量超过请求页大小");
      if (!rows.length) { ended = true; break; }
      for (const row of rows) {
        const barcode = String(row.skuBarcode ?? "");
        if (!expected.has(barcode)) throw new ApiFailure(`返回了清单以外的条码 ${barcode.slice(0,80)}，未发布本次数据`);
        seen.add(barcode);
        verifyRow?.(row);
      }
      const added = accumulatePage(state, rows, warehouse.name, warehouse.id);
      if (!added) throw new ApiFailure(`第 ${pageCount} 次请求完全重复，采集已终止以防无限分页`);
    }
    if (!ended) throw new ApiFailure("单批条码超过 100 页仍未结束，未发布本次库存");
    const missing = batch.filter(barcode => !seen.has(barcode));
    if (missing.length && !allowMissing) throw new ApiFailure(`有 ${missing.length} 个条码未返回：${missing.slice(0,3).join("、")}。请核对条码和仓库，本次未发布；缺失不当作 0。`);
    await onPage(pageCount, state.recordCount, state.goods.size);
  }
  return { rows: aggregatedRows(state), pageCount, recordCount: state.recordCount, duplicateCount: state.duplicateCount };
}
