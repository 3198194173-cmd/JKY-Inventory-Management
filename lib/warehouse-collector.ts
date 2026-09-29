import { createHash } from "node:crypto";
import { ApiFailure, collectStock, GATEWAY, jackyunSign, shanghaiTimestamp, STOCK_PAGE_SIZE } from "./jackyun";
import { parseLosslessJson } from "./lossless-json";
import { stockScope } from "./stock-scope";

type CatalogRow = Record<string, unknown>;
export type Catalog = { rows: CatalogRow[]; code: string; id: string; name: string; pageCount: number; hash: string };
const field = (row: CatalogRow, key: string) => {
  const value = row[key];
  if (typeof value !== "string" || !value.trim()) throw new ApiFailure(`仓库 SKU 清单缺少 ${key}`);
  return value.trim();
};

export async function fetchCatalogPage(appkey: string, secret: string, code: string, pageIndex: number, fetcher: typeof fetch = fetch): Promise<CatalogRow[]> {
  const bizcontent = JSON.stringify({ pageIndex, pageSize: STOCK_PAGE_SIZE, warehouseCode: code, isNotQueryBatchStock: "1", isBlockup: "1" });
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
  let id = "", name = "", pageCount = 0, ended = false;
  // The documented offset window is 10,000 records. Reject rather than publish a truncated catalog.
  for (let page = 0; page <= 50; page++) {
    const batch = await pageFetcher(appkey, secret, code, page); pageCount++;
    if (batch.length > STOCK_PAGE_SIZE) throw new ApiFailure("SKU 清单返回数量超过分页上限");
    if (!batch.length) { ended = true; break; }
    for (const row of batch) {
      if (field(row, "warehouseCode") !== code) throw new ApiFailure("SKU 清单返回了其他仓库，本次未发布");
      const rowId = field(row, "warehouseId"), rowName = field(row, "warehouseName");
      if (id && (id !== rowId || name !== rowName)) throw new ApiFailure("SKU 清单仓库身份不一致");
      id = rowId; name = rowName;
      const identity = field(row, "quantityId");
      if (identities.has(identity)) throw new ApiFailure("SKU 清单分页出现重复记录，本次未发布");
      identities.add(identity);
      for (const key of ["skuId", "skuBarcode", "goodsNo", "goodsName", "unitName", "ownerName"]) field(row, key);
      rows.push(row);
    }
    await onPage(pageCount, rows.length);
  }
  if (!ended) throw new ApiFailure("仓库超过 10,000 条 SKU，需要启用游标查询；本次未发布截断数据");
  if (!rows.length) throw new ApiFailure("该仓库没有返回 SKU，请检查编码、权限或仓库是否为空；未生成零库存记录");
  const hash = createHash("sha256").update(JSON.stringify(rows.map(r => [r.quantityId, r.skuId, r.skuBarcode]).sort())).digest("hex");
  return { rows, code, id, name, pageCount, hash };
}

export async function collectWarehouseStock(appkey: string, secret: string, code: string, onPage: (pages: number, records: number, goods: number) => Promise<void>, catalogFetcher = fetchCatalogPage, stockFetcher?: Parameters<typeof collectStock>[3], expectedWarehouseId?: string | null) {
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
  const scope = stockScope(catalog.rows.map(r => field(r, "skuBarcode")).join("\n"), `${code} 自动 SKU 清单`);
  const result = await collectStock(appkey, secret, (pages, records, goods) => onPage(catalog.pageCount + pages, records, goods), stockFetcher, scope, { code, id: catalog.id, name: catalog.name }, row => {
    const key = identity(row), original = expected.get(key);
    if (!original) throw new ApiFailure("可购数量返回了清单以外的规格或货主，本次未发布");
    if (row.ownerName != null && field(row, "ownerName") !== field(original, "ownerName")) throw new ApiFailure("SKU 清单与可购数量的货主不一致，本次未发布");
    if (row.ownerId != null && String(row.ownerId) !== String(original.ownerId)) throw new ApiFailure("SKU 清单与可购数量的货主身份不一致，本次未发布");
    for (const name of ["goodsNo", "unitName", "skuBarcode"]) if (field(row, name) !== field(original, name)) throw new ApiFailure("SKU 清单与可购数量的货品或单位不一致，本次未发布");
    // Canonical catalog identity prevents optional owner fields from making
    // identical stock rows look like different owners to the accumulator.
    row.ownerId = original.ownerId ?? null;
    row.ownerName = original.ownerName;
    seen.add(key);
  });
  if (seen.size !== expected.size) throw new ApiFailure(`有 ${expected.size - seen.size} 个规格未返回可购数量，本次未发布；缺失不当作 0`);
  if (result.recordCount !== expected.size) throw new ApiFailure("库存规格数量与目录不一致，本次未发布");
  return { ...result, pageCount: catalog.pageCount + result.pageCount, catalog, scope };
}
