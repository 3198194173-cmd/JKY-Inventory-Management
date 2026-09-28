import sample from "@/data/stock-sample.json";
import { accumulatePage, aggregatedRows, createAccumulator } from "./stock-aggregation";
import { addQuantity, compareQuantity } from "./decimal";
import { WAREHOUSE_CODE, WAREHOUSE_NAME } from "./jackyun";
import type { InventoryView, StockRow } from "./inventory-types";

export function summarizeRows(rows: StockRow[]) {
  const totalsByUnit: Record<string, string> = {};
  let zeroCount = 0, negativeCount = 0;
  for (const row of rows) {
    totalsByUnit[row.unitName] = addQuantity(totalsByUnit[row.unitName] || "0", row.quantity);
    const sign = compareQuantity(row.quantity, "0");
    if (sign === 0) zeroCount++;
    if (sign < 0) negativeCount++;
  }
  return { totalsByUnit, zeroCount, negativeCount };
}

export function sampleView(configured = false, robotConfigured = false): InventoryView {
  const state = createAccumulator();
  accumulatePage(state, sample, WAREHOUSE_NAME);
  const rows = aggregatedRows(state);
  const snapshot = { id: "sample-20260928", capturedAt: "2026-09-28", date: "2026-09-28", source: "sample" as const, pageCount: 1, recordCount: 12, scope: null };
  return { warehouseCode: WAREHOUSE_CODE, warehouseName: WAREHOUSE_NAME, source: "sample", snapshot, snapshots: [snapshot], rows: rows.map(row => ({ ...row, history: { [snapshot.date]: row.quantity } })), configured, robotConfigured, totalRows: rows.length, goodsCount: rows.length, page: 1, pageSize: 50, ...summarizeRows(rows) };
}
