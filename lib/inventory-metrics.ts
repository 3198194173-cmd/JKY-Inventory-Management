import { addQuantity, compareQuantity, divideQuantity, multiplyQuantityByInteger } from "./decimal";
import { dailySales, reconciledSales, type DailyValue } from "./daily-sales";
import type { InboundReconciliation } from "./inbound";

export type InventoryMetrics = {
  average7: string | null;
  turnoverDays: string | null;
  validDays: number;
  basis: "inventory_difference" | "inbound_adjusted_difference";
  reason: "insufficient_data" | "inbound_unverified" | "no_consumption" | "net_returns" | "negative_inventory" | null;
};

// Always use the seven calendar days immediately before the latest capture date.
// Selecting a wider display range must not change this window or fill missing days.
export function recentSalesDates(asOfDate: string): string[] {
  const date = new Date(asOfDate + "T00:00:00Z");
  return Array.from({ length: 7 }, () => {
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  });
}

export function inventoryMetrics(values: DailyValue[], asOfDate: string, stock: string, unitName: string, corrections: Record<string, InboundReconciliation> = {}): InventoryMetrics {
  const dates = recentSalesDates(asOfDate), raw = dailySales(values, dates, unitName), sales = reconciledSales(raw, corrections);
  const valid = dates.flatMap(date => sales[date] == null ? [] : [sales[date]!]);
  const result: InventoryMetrics = { average7: null, turnoverDays: null, validDays: valid.length, basis: dates.some(d => corrections[d]?.status === "verified") ? "inbound_adjusted_difference" : "inventory_difference", reason: "insufficient_data" };
  if (dates.some(d => raw[d] != null && sales[d] == null)) return { ...result, reason: "inbound_unverified" };
  if (valid.length !== 7) return result;
  // Keep returns/backfill signed; every verified day participates in the mean.
  const total = valid.reduce(addQuantity, "0");
  result.average7 = divideQuantity(total, "7");
  if (compareQuantity(total, "0") === 0) return { ...result, reason: "no_consumption" };
  if (compareQuantity(total, "0") < 0) return { ...result, reason: "net_returns" };
  if (compareQuantity(stock, "0") < 0) return { ...result, reason: "negative_inventory" };
  // stock / (total / 7), using the unrounded total rather than the displayed mean.
  return { ...result, turnoverDays: divideQuantity(multiplyQuantityByInteger(stock, 7), total), reason: null };
}
