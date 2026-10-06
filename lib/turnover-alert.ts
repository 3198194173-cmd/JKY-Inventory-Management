import { compareQuantity, multiplyQuantityByInteger, normalizeQuantity } from "./decimal";
import type { InventoryMetrics } from "./inventory-metrics";

export const DEFAULT_TURNOVER_AVERAGE_THRESHOLD = "3";
export const TURNOVER_ALERT_DAYS = 30;

export function normalizeTurnoverThreshold(value: unknown): string {
  try {
    if (typeof value === "string" && value.length > 30) throw new Error();
    const threshold = normalizeQuantity(value);
    if (compareQuantity(threshold,"0") < 0 || compareQuantity(threshold,"1000000") > 0) throw new Error();
    return threshold;
  } catch {
    throw new Error("销量均值门槛须为 0 至 1000000 的有效数量");
  }
}

export function turnoverAlert(metrics: InventoryMetrics | undefined, stock: string, averageThreshold: string): boolean {
  if (!metrics || metrics.reason !== null || metrics.validDays !== 7 || metrics.total7 == null || metrics.average7 == null || metrics.turnoverDays == null) return false;
  const total = metrics.total7;
  if (compareQuantity(total,"0") <= 0 || compareQuantity(stock,"0") < 0) return false;
  // Compare unrounded ratios by cross multiplication with exact decimal arithmetic.
  return compareQuantity(total,multiplyQuantityByInteger(averageThreshold,7)) > 0
    && compareQuantity(multiplyQuantityByInteger(stock,7),multiplyQuantityByInteger(total,TURNOVER_ALERT_DAYS)) < 0;
}
