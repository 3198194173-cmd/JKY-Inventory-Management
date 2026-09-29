import { addQuantity, normalizeQuantity } from "./decimal";
import type { StockRow } from "./inventory-types";

export type StockAccumulator = {
  identities: Map<string, string>;
  goods: Map<string, StockRow>;
  recordCount: number;
  duplicateCount: number;
};

export function createAccumulator(): StockAccumulator {
  return { identities: new Map(), goods: new Map(), recordCount: 0, duplicateCount: 0 };
}

function identifier(value: unknown, field: string): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error(`${field} 精度无法核验`);
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") throw new Error(`缺少 ${field}`);
  return String(value);
}

export function accumulatePage(state: StockAccumulator, rows: Record<string, unknown>[], warehouseName: string, expectedWarehouseId = "2391620541187785472"): number {
  let newRecords = 0;
  for (const row of rows) {
    const goodsNo = identifier(row.goodsNo, "goodsNo");
    const skuId = identifier(row.skuId, "skuId");
    const goodsName = typeof row.goodsName === "string" ? row.goodsName.trim() : "";
    const unitName = typeof row.unitName === "string" ? row.unitName.trim() : "";
    if (!goodsName || !unitName) throw new Error(`货品 ${goodsNo} 缺少名称或单位`);
    if (row.warehouseName !== warehouseName) throw new Error(`货品 ${goodsNo} 的仓库名称不符`);
    const warehouseId = identifier(row.warehouseId, "warehouseId");
    if (warehouseId !== expectedWarehouseId) throw new Error(`货品 ${goodsNo} 的仓库身份不符`);
    const owner = row.ownerId != null ? identifier(row.ownerId, "ownerId") : row.ownerName != null ? identifier(row.ownerName, "ownerName") : "";
    const identity = `${warehouseId}|${skuId}|${owner}`;
    const quantity = normalizeQuantity(row.orderAbleQuantity);
    const fingerprint = JSON.stringify([goodsNo, goodsName, unitName, quantity]);
    const seen = state.identities.get(identity);
    if (seen !== undefined) {
      if (seen !== fingerprint) throw new Error(`货品 ${goodsNo} 的重复记录数量或字段冲突`);
      state.duplicateCount++;
      continue;
    }
    const existing = state.goods.get(goodsNo);
    if (existing && (existing.goodsName !== goodsName || existing.unitName !== unitName)) {
      throw new Error(`货品 ${goodsNo} 的名称或单位冲突，无法自动合并`);
    }
    state.identities.set(identity, fingerprint);
    state.goods.set(goodsNo, existing ? { ...existing, quantity: addQuantity(existing.quantity, quantity), skuCount: existing.skuCount + 1 } : { goodsNo, goodsName, unitName, quantity, skuCount: 1 });
    state.recordCount++;
    newRecords++;
  }
  return newRecords;
}

export function aggregatedRows(state: StockAccumulator): StockRow[] {
  return Array.from(state.goods.values()).sort((a, b) => a.goodsNo.localeCompare(b.goodsNo));
}
