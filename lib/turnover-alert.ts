import { compareQuantity, multiplyQuantity, multiplyQuantityByInteger, normalizeQuantity } from "./decimal";
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

export function normalizeTurnoverDays(value: unknown): string {
  try {
    if (typeof value === "string" && value.length > 30) throw new Error();
    const days = normalizeQuantity(value);
    if (compareQuantity(days,"0") <= 0 || compareQuantity(days,"1000000") > 0) throw new Error();
    return days;
  } catch { throw new Error("库存周转门槛须大于0且不超过1000000天"); }
}

export function normalizeExcludedNames(value: unknown): string[] {
  if (typeof value === "string") {
    if (value.length > 5000) throw new Error("名称排除关键词过长");
    value = value.split(/[\n,，;；]+/);
  }
  if (!Array.isArray(value) || value.length > 100 || value.some(v=>typeof v!=="string" || v.length>100)) throw new Error("名称排除关键词最多100个，每个不超过100字");
  return [...new Set((value as string[]).map(v=>v.trim().normalize("NFKC").toLowerCase()).filter(Boolean))].sort();
}

export function excludedByName(name: string, keywords: string[]): boolean {
  const normalized = name.normalize("NFKC").toLowerCase();
  return keywords.some(keyword=>normalized.includes(keyword));
}

export function turnoverAlert(metrics: InventoryMetrics | undefined, stock: string, averageThreshold: string, turnoverDays = String(TURNOVER_ALERT_DAYS)): boolean {
  if (!metrics || (metrics.reason !== null && metrics.reason !== "negative_inventory") || metrics.validDays !== 7 || metrics.total7 == null || metrics.average7 == null || metrics.turnoverDays == null) return false;
  const total = metrics.total7;
  if (compareQuantity(total,"0") <= 0) return false;
  // Compare unrounded ratios by cross multiplication with exact decimal arithmetic.
  return compareQuantity(total,multiplyQuantityByInteger(averageThreshold,7)) > 0
    && compareQuantity(multiplyQuantityByInteger(stock,7),multiplyQuantity(total,turnoverDays)) < 0;
}
