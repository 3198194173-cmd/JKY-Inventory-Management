import { createHash } from "node:crypto";

export type StockScope = { barcodes: string[]; label: string; key: string };
export type ScopeInfo = { label: string; count: number; key: string };
export const BARCODE_BATCH_SIZE = 500;

export function stockScope(text: unknown, label: unknown = "指定条码清单"): StockScope {
  if (typeof text !== "string" || text.length > 2_000_000) throw new Error("请粘贴条码清单，最多 20000 个条码");
  const barcodes = [...new Set(text.split(/[\r\n\t,，;；]+/).map(v => v.trim()).filter(v => v && !["skuBarcode", "条码", "规格条码"].includes(v)))].sort();
  if (!barcodes.length || barcodes.length > 20_000) throw new Error("条码清单须包含 1 至 20000 个条码");
  if (barcodes.some(v => v.length > 200 || /[\u0000-\u001f\u007f]/.test(v))) throw new Error("存在过长或包含控制字符的条码，请每行粘贴一个完整条码");
  const name = typeof label === "string" ? label.trim() : "";
  if (!name || name.length > 80) throw new Error("请填写 1 至 80 字的范围名称");
  return { barcodes, label: name, key: createHash("sha256").update(JSON.stringify(barcodes)).digest("hex") };
}

export const scopeInfo = (scope: StockScope): ScopeInfo => ({ label: scope.label, count: scope.barcodes.length, key: scope.key });
export function barcodeBatches(scope: StockScope) {
  const batches: string[][] = [];
  for (let i = 0; i < scope.barcodes.length; i += BARCODE_BATCH_SIZE) batches.push(scope.barcodes.slice(i, i + BARCODE_BATCH_SIZE));
  return batches;
}
