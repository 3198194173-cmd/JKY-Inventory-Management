import { createHash } from "node:crypto";
import { ApiFailure, collectStock, fetchStockPage, GATEWAY, jackyunSign, shanghaiTimestamp, STOCK_PAGE_SIZE } from "./jackyun";
import { parseLosslessJson } from "./lossless-json";
import { createAccumulator, accumulatePage, aggregatedRows } from "./stock-aggregation";
import type { UnavailableSku } from "./inventory-types";

type CatalogRow = Record<string, unknown>;
export type Catalog = { rows: CatalogRow[]; code: string; id: string; name: string; pageCount: number; hash: string };
const field = (row: CatalogRow, key: string) => {
  const value = row[key];
  if (typeof value !== "string" || !value.trim()) throw new ApiFailure(`仓库 SKU 清单缺少 ${key}`);
  return value.trim();
};

export async function fetchCatalogPage(appkey: string, secret: string, code: string, pageIndex: number, fetcher: typeof fetch = fetch, maxQuantityId?: string): Promise<CatalogRow[]> {
  const bizcontent = JSON.stringify({ pageIndex, pageSize: STOCK_PAGE_SIZE, warehouseCode: code, isNotQueryBatchStock: "1", isBlockup: "1", ...(maxQuantityId === undefined ? {} : {maxQuantityId}) });
  for (let attempt = 0; attempt < 3; attempt++) {
    const params = { appkey, bizcontent, contenttype: "json", method: "erp.stockquantity.get", timestamp: shanghaiTimestamp(), version: "v1.0" };
    let response: Response;
    try { response = await fetcher(GATEWAY, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: new URLSearchParams({ ...params, sign: jackyunSign(params, secret) }), signal: AbortSignal.timeout(25_000) }); }
    catch { if (attempt < 2) continue; throw new ApiFailure("仓库 SKU 清单请求超时，请重试"); }
    if ((response.status === 429 || response.status >= 500) && attempt < 2) continue;
    if (!response.ok) throw new ApiFailure(`仓库 SKU 清单请求失败（HTTP ${response.status}）`);
    let body: { code?: unknown; subCode?: unknown; result?: { data?: { goodsStockQuantity?: unknown }; noPrivilegeItem?: unknown } };
    try { body = parseLosslessJson(await response.text()) as typeof body; } catch { throw new ApiFailure("仓库 SKU 清单不是有效 JSON"); }
    if (Number(body.code) !== 200) throw new ApiFailure(`仓库 SKU 清单查询失败（错误码 ${String(body.subCode ?? body.code).replace(/[^\w-]/g, "").slice(0,30)}），请检查接口权限与仓库编码`);
    const restricted = body.result?.noPrivilegeItem;
    if (restricted != null && !["[]", "{}", '""'].includes(JSON.stringify(restricted))) throw new ApiFailure("仓库 SKU 清单包含权限受限字段");
    const rows = body.result?.data?.goodsStockQuantity;
    if (!Array.isArray(rows) || rows.some(r => !r || typeof r !== "object" || Array.isArray(r))) throw new ApiFailure("仓库 SKU 清单结构不完整");
    return rows;
  }
  throw new ApiFailure("仓库 SKU 清单请求失败");
}

export async function discoverCatalog(appkey: string, secret: string, code: string, onPage: (pages: number, records: number) => Promise<void>, pageFetcher = fetchCatalogPage): Promise<Catalog> {
  const rows: CatalogRow[] = [], identities = new Set<string>();
  let id = "", name = "", pageCount = 0, ended = false, maxQuantityId = "0";
  // Official cursor mode keeps pageIndex=0 and advances the last quantityId.
  // It avoids the 10,000-record offset window and detects ignored cursors.
  for (let page = 0; page < 1000; page++) {
    const batch = await pageFetcher(appkey, secret, code, 0, fetch, maxQuantityId); pageCount++;
    if (batch.length > STOCK_PAGE_SIZE) throw new ApiFailure("SKU 清单返回数量超过分页上限");
    if (!batch.length) { ended = true; break; }
    for (const row of batch) {
      if (field(row, "warehouseCode") !== code) throw new ApiFailure("SKU 清单返回了其他仓库，本次未发布");
      const rowId = field(row, "warehouseId"), rowName = field(row, "warehouseName");
      if (id && (id !== rowId || name !== rowName)) throw new ApiFailure("SKU 清单仓库身份不一致");
      id = rowId; name = rowName;
      const identity = field(row, "quantityId");
      if (!/^\d+$/.test(identity) || BigInt(identity) <= BigInt(maxQuantityId)) throw new ApiFailure("SKU 清单游标没有递增，本次未发布");
      if (identities.has(identity)) throw new ApiFailure("SKU 清单分页出现重复记录，本次未发布");
      identities.add(identity);
      for (const key of ["skuId", "goodsNo", "goodsName", "unitName", "ownerName"]) field(row, key);
      if (row.skuBarcode != null && typeof row.skuBarcode !== "string") throw new ApiFailure("仓库 SKU 条码格式无效");
      maxQuantityId = identity;
      rows.push(row);
    }
    if (pageCount % 5 === 0 || batch.length < STOCK_PAGE_SIZE) await onPage(pageCount, rows.length);
  }
  if (!ended) throw new ApiFailure("仓库 SKU 清单超过 200,000 条保护上限，本次未发布截断数据");
  if (!rows.length) throw new ApiFailure("该仓库没有返回 SKU，请检查编码、权限或仓库是否为空；未生成零库存记录");
  const hash = createHash("sha256").update(JSON.stringify(rows.map(r => [r.quantityId, r.skuId, r.skuBarcode]).sort())).digest("hex");
  return { rows, code, id, name, pageCount, hash };
}

export async function collectWarehouseStock(appkey: string, secret: string, code: string, onPage: (pages: number, records: number, goods: number) => Promise<void>, catalogFetcher = fetchCatalogPage, stockFetcher?: Parameters<typeof collectStock>[3], expectedWarehouseId?: string | null, allowUnavailable = false) {
  const catalog = await discoverCatalog(appkey, secret, code, (pages, records) => onPage(pages, records, 0), catalogFetcher);
  if (expectedWarehouseId && catalog.id !== expectedWarehouseId) throw new ApiFailure("该仓库编码对应的仓库身份已改变，请核对应用与仓库；旧历史不会与新仓库合并");
  const expected = new Map<string, CatalogRow>(), seen = new Set<string>();
  // The stock API often omits owner fields. Only a uniquely owned SKU in the
  // catalog may be matched that way; ambiguous owners fail closed.
  const identity = (r: CatalogRow) => field(r, "skuId");
  for (const row of catalog.rows) {
    const key = identity(row);
    if (expected.has(key)) throw new ApiFailure("同一规格存在多条库存目录或多个货主，无法核验唯一库存");
    expected.set(key, row);
  }
  const barcodes = [...new Set(catalog.rows.map(r => typeof r.skuBarcode === "string" ? r.skuBarcode.trim() : "").filter(Boolean))].sort();
  if (barcodes.some(v => v.length > 200 || /[\u0000-\u001f\u007f,]/.test(v))) throw new ApiFailure("仓库 SKU 条码包含无效字符或过长，本次未发布");
  const scope = {barcodes, label:`${code} 自动 SKU 清单`, key:catalog.hash};
  const state = createAccumulator();
  const verify = (row: CatalogRow) => {
    const key = identity(row), original = expected.get(key);
    if (!original) throw new ApiFailure("可购数量返回了清单以外的规格或货主，本次未发布");
    if (row.ownerName != null && field(row, "ownerName") !== field(original, "ownerName")) throw new ApiFailure("SKU 清单与可购数量的货主不一致，本次未发布");
    if (row.ownerId != null && String(row.ownerId) !== String(original.ownerId)) throw new ApiFailure("SKU 清单与可购数量的货主身份不一致，本次未发布");
    for (const name of ["goodsNo", "unitName"]) if (field(row, name) !== field(original, name)) throw new ApiFailure("SKU 清单与可购数量的货品或单位不一致，本次未发布");
    if (typeof original.skuBarcode === "string" && original.skuBarcode.trim() && field(row, "skuBarcode") !== original.skuBarcode.trim()) throw new ApiFailure("SKU 清单与可购数量的条码不一致，本次未发布");
    // Canonical catalog identity prevents optional owner fields from making
    // identical stock rows look like different owners to the accumulator.
    row.ownerId = original.ownerId ?? null;
    row.ownerName = original.ownerName;
    seen.add(key);
  };
  let stockPages = 0;
  if (barcodes.length) {
    const result = await collectStock(appkey, secret, (pages, records, goods) => onPage(catalog.pageCount + pages, records, goods), stockFetcher, scope, { code, id: catalog.id, name: catalog.name }, verify, state, true, 2);
    stockPages = result.pageCount;
  }
  for (const goodsNo of new Set(catalog.rows.filter(r => !seen.has(identity(r))).map(r => field(r,"goodsNo")))) {
    let ended = false; const fingerprints = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const batch = await (stockFetcher || fetchStockPage)(appkey, secret, page, fetch, [], code, goodsNo); stockPages++;
      if (batch.length > STOCK_PAGE_SIZE) throw new ApiFailure("货品查询返回数量超过分页上限");
      if (!batch.length) { ended = true; break; }
      const fingerprint = JSON.stringify(batch);
      if (fingerprints.has(fingerprint)) throw new ApiFailure("货品查询分页重复，本次未发布");
      fingerprints.add(fingerprint);
      for (const row of batch) { if (field(row,"goodsNo") !== goodsNo) throw new ApiFailure("货品编码查询返回其他货品，本次未发布"); verify(row); }
      accumulatePage(state, batch, catalog.name, catalog.id);
    }
    if (!ended) throw new ApiFailure("单个货品查询超过分页保护上限，本次未发布");
    await onPage(catalog.pageCount + stockPages, state.recordCount, state.goods.size);
  }
  // Combination codes without a purchasable-stock result are outside the
  // user's inventory scope. Never manufacture zero or sum component stock.
  const missing = catalog.rows.filter(row => !seen.has(identity(row)));
  const unavailable: UnavailableSku[] = missing.filter(row => !field(row, "goodsNo").includes("+")).map(row => ({skuId:field(row,"skuId"),goodsNo:field(row,"goodsNo"),goodsName:field(row,"goodsName"),skuName:typeof row.skuName === "string" ? row.skuName : "",skuBarcode:typeof row.skuBarcode === "string" ? row.skuBarcode.trim() : "",unitName:field(row,"unitName"),reason:row.skuBarcode ? "按条码及货品编码查询均未返回可购数量" : "无条码；按货品编码查询未返回可购数量"}));
  if (unavailable.length && !allowUnavailable) throw new ApiFailure(`有 ${unavailable.length} 个规格未返回可购数量（包括无条码规格），本次未发布；缺失不当作 0`);
  if (!state.recordCount) throw new ApiFailure("该仓库未取得任何可核验的可购库存，本次未保存");
  if (state.recordCount + missing.length !== expected.size) throw new ApiFailure("库存规格数量与目录不一致，本次未发布");
  // Never publish a misleading partial total for a goodsNo with one missing variant.
  const incompleteGoods = new Set(missing.map(row => field(row, "goodsNo")));
  const rows = aggregatedRows(state).filter(row => !incompleteGoods.has(row.goodsNo));
  if (!rows.length) throw new ApiFailure("没有规格齐全的可核验货品，本次未保存");
  return { rows, pageCount: catalog.pageCount + stockPages, recordCount:state.recordCount, duplicateCount:state.duplicateCount, catalog, scope, unavailable };
}
