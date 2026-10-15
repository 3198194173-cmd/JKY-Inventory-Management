import type { InventoryView } from "@/lib/inventory-types";
import type { InventoryMetrics } from "@/lib/inventory-metrics";
import { compareQuantity } from "@/lib/decimal";
import { reconciliationDiagnostic } from "@/lib/reconciliation-diagnostics";

export const quantity = (value: string) => { const [a,b] = value.split("."); return a.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (b ? "." + b : ""); };
export function MetricValue({ metrics, field, warningTitle }: { metrics?: InventoryMetrics; field: "average7" | "turnoverDays"; warningTitle?: string }) {
  const value = metrics?.[field];
  if (value != null) return <strong className={warningTitle ? "compact-turnover-warning" : undefined} aria-label={warningTitle ? `${quantity(value)}天，库存周转预警` : undefined} title={warningTitle || "全部可比较日期按仓库区间核验入库；仍为库存消耗估算，其他库存变动可能影响结果"}>{quantity(value)}</strong>;
  const reason = metrics?.reason;
  const label = reason === "inbound_unverified" ? "库存变动待核对" : reason === "no_consumption" ? "无净消耗" : reason === "net_returns" ? "净退货/回补" : reason === "negative_inventory" ? "库存为负" : "不足7天";
  return <span className="compact-metric-empty" title={reason === "insufficient_data" || !metrics ? `最近7天仅有 ${metrics?.validDays || 0} 天可计算；缺日、缺货品或单位变化不补零` : label}><span className="compact-muted">—</span><small>{label}</small></span>;
}
export function hasInbound(row: InventoryView["rows"][number], date: string) {
  if (row.salesHints) return !!row.salesHints[date]?.hasInbound;
  const correction=row.inbound?.[date];
  return !!correction && (correction.hasPositiveInbound || correction.records.some(r=>compareQuantity(r.quantity,"0")>0) || (correction.inboundQuantity != null && compareQuantity(correction.inboundQuantity,"0")>0));
}
export function SalesValue({ row, date }: { row: InventoryView["rows"][number]; date: string }) {
  if (row.salesHints) {
    const hint=row.salesHints[date],value=row.sales?.[date];
    return <span className="compact-sales-value" title={hint?.title || "库存消耗估算；点击货品查看核算与单据"}>{value == null ? "—" : quantity(value)}{hint?.pendingLabel && <small className="compact-sales-note">{hint.pendingLabel}</small>}</span>;
  }
  const correction = row.inbound?.[date], value = row.sales?.[date];
  const diagnostic = reconciliationDiagnostic(correction);
  const pending = row.rawSales?.[date] != null && value == null;
  return <span className="compact-sales-value" title={diagnostic?.message || correction?.error || (pending ? "该采集区间入库未核验；点击货品查看详情" : correction?.status === "verified" ? `原始差额 ${correction.rawDifference} + 入库 ${correction.inboundQuantity}；点击查看单据` : "库存差额估算")}>{value == null ? "—" : quantity(value)}{pending && <small className="compact-sales-note">{diagnostic?.increase ? `回补 ${quantity(diagnostic.increase)} · 待核对` : "待核验"}</small>}</span>;
}
