"use client";

import { useState } from "react";
import { ChartNoAxesCombined, ChevronDown, CircleHelp, Warehouse } from "lucide-react";
import type { InventoryView } from "@/lib/inventory-types";
import { INVENTORY_FIELD_HELP } from "@/lib/inventory-field-help";
import { compareQuantity } from "@/lib/decimal";
import { turnoverAlert } from "@/lib/turnover-alert";
import { MetricValue, SalesValue, hasInbound, quantity } from "./inventory-values";
import { TransitStatusBadge } from "./transit-status-badge";
import { Button } from "./ui/button";

type Row = InventoryView["rows"][number];
type Props = {
  view: InventoryView;
  dates: string[];
  threshold: string | null;
  turnoverDays: string;
  loading: boolean;
  onSelect: (row: Row, date?: string) => void;
  onTransit: (goodsNo: string) => void;
  onSync: () => void;
  canSync: boolean;
};

function ProductCard({ row, index, dates, threshold, turnoverDays, onSelect, onTransit }: Pick<Props, "dates" | "threshold" | "turnoverDays" | "onSelect" | "onTransit"> & { row: Row; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const warning = threshold !== null && turnoverAlert(row.metrics, row.quantity, threshold, turnoverDays);
  const warningTitle = warning ? `周转预警：销量均值 > ${threshold} 且库存周转 < ${turnoverDays}天；按未舍入值判断` : undefined;
  const visibleDates = expanded ? dates : dates.slice(0, 7);
  return <article className="inventory-mobile-card" aria-label={`${row.goodsNo} 库存与销售`}>
    <header className="inventory-mobile-product">
      <div className="inventory-mobile-product-heading"><span className="inventory-mobile-index">{index}</span><strong>{row.goodsNo}</strong><TransitStatusBadge transit={row.transit} unitName={row.unitName}/></div>
      <p>{row.goodsName}</p>
    </header>
    <div className="inventory-mobile-stock">
      <div><span>当前库存 <small>{row.unitName}</small></span><strong className={warning && compareQuantity(row.quantity, "0") < 0 ? "compact-turnover-warning" : undefined}>{quantity(row.quantity)}</strong></div>
      <button type="button" onClick={() => onSelect(row)}><ChartNoAxesCombined size={16}/>趋势与日历</button>
    </div>
    <dl className="inventory-mobile-metrics">
      <div><dt>销售均值 <small>/ 天</small></dt><dd><MetricValue metrics={row.metrics} field="average7"/></dd></div>
      <div><dt>库存周转 <small>/ 天</small></dt><dd><MetricValue metrics={row.metrics} field="turnoverDays" warningTitle={warningTitle}/></dd></div>
      <div><dt>在途数量</dt><dd><button type="button" className="transit-link" onClick={() => onTransit(row.goodsNo)} aria-label={`${row.goodsNo} 在途数量 ${row.transit?.quantity ?? "待核验"}，查看记录`}>{row.transit?.quantity == null ? "待核验" : quantity(row.transit.quantity)}</button></dd></div>
      <div><dt>建议补货 <small>/ 30天</small></dt><dd>{row.transit?.replenishment == null ? <span className="compact-metric-empty"><span className="compact-muted">—</span><small>{row.transit?.reason || "均值或在途待核验"}</small></span> : row.transit.replenishment === "0" ? <span className="inventory-mobile-no-replenishment">无需补货</span> : <strong>{quantity(row.transit.replenishment)}</strong>}</dd></div>
    </dl>
    <section className="inventory-mobile-sales" aria-label={`${row.goodsNo} 每日销量`}>
      <div className="inventory-mobile-sales-heading"><h3>每日销量</h3><span>点日期查看核算</span></div>
      <div className="inventory-mobile-days">{visibleDates.map(date => <button key={date} type="button" className={hasInbound(row, date) ? "inventory-mobile-inbound" : undefined} aria-label={`${date}，销量${row.sales?.[date] ?? "暂无有效数据"}${hasInbound(row, date) ? "，有入库" : ""}，查看核算`} onClick={() => onSelect(row, date)}><time dateTime={date}>{date.slice(5)}</time><SalesValue row={row} date={date}/></button>)}</div>
      {!dates.length && <p className="inventory-mobile-hint">暂无可比较的日期</p>}
      {dates.length > 7 && <button type="button" className="inventory-mobile-expand" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>{expanded ? "收起其余日期" : `查看全部 ${dates.length} 天`}<ChevronDown size={14}/></button>}
    </section>
  </article>;
}

export function InventoryMobileList({ view, dates, threshold, turnoverDays, loading, onSelect, onTransit, onSync, canSync }: Props) {
  const [limit, setLimit] = useState(20);
  const shown = Math.min(limit, view.rows.length);
  const help = [["当前库存", INVENTORY_FIELD_HELP.quantity], ["销售均值", INVENTORY_FIELD_HELP.average], ["每日销量", "净销量=期初库存+区间实际入库−期末库存；实际入库来源 erp-busiorder.goodsdocin.search。日期为采集区间起始日，负值按退货/回补；缺失或未核验显示—。黄色日期格表示有入库，点日期查看计算与单据。"], ["库存周转", INVENTORY_FIELD_HELP.turnover], ["在途数量", INVENTORY_FIELD_HELP.transit], ["建议补货 / 30天", INVENTORY_FIELD_HELP.replenishment]];
  return <div className="inventory-mobile" aria-label="手机货品列表" aria-busy={loading}>
    <details className="inventory-mobile-help"><summary><CircleHelp size={15}/>指标与计算说明</summary><dl>{help.map(([label, description]) => <div key={label}><dt>{label}</dt><dd>{description}</dd></div>)}</dl></details>
    {!!view.rows.length && <p className="inventory-mobile-count">本页已显示 {shown} / {view.rows.length} 件<span>概览统计按整页计算</span></p>}
    <div className="inventory-mobile-products">{view.rows.slice(0, shown).map((row, i) => <ProductCard key={row.goodsNo} row={row} index={(view.page - 1) * view.pageSize + i + 1} dates={dates} threshold={threshold} turnoverDays={turnoverDays} onSelect={onSelect} onTransit={onTransit}/>)}</div>
    {shown < view.rows.length && <Button variant="outline" className="inventory-mobile-more" disabled={loading} onClick={() => setLimit(n => n + 20)}>继续显示本页商品（还有 {view.rows.length - shown} 件）</Button>}
    {!view.rows.length && <div className="compact-empty"><Warehouse size={32}/><strong>{loading ? "正在读取仓库数据" : view.snapshot ? "没有符合条件的货品" : "从第一次库存采集开始"}</strong><p>{view.snapshot ? "可调整搜索条件。" : "自动获取该仓库 SKU 并采集可购数量。"}</p>{!view.snapshot && <Button onClick={onSync} disabled={loading || !canSync}>采集库存</Button>}</div>}
  </div>;
}
