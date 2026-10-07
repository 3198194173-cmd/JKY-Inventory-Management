import type { InventoryView } from "./inventory-types";
import { recentSalesDates } from "./inventory-metrics";
import { TURNOVER_ALERT_DAYS } from "./turnover-alert";

export type TurnoverCard = {
  title: string; summary: string; footer: string; dates: string[];
  totalCount: number; part: number; totalParts: number;
  rows: { goodsNo: string; goodsName: string; unitName: string; quantity: string; average: string; turnover: string; sales: (string | null)[] }[];
};
export const CARD_ROWS_PER_PAGE = 12;
// The native chart protocol supports explicit ticks and padding. Keep the row
// compact; the native detail action exposes the same real points at full size.
export const NATIVE_TREND_CONFIG = { xAxisConfig: { ticks: [] }, yAxisConfig: { ticks: [] }, padding: [4, 4, 4, 4] };
export function turnoverCards(rows: InventoryView["rows"], threshold: string, warehouse: string, capturedAt: string): TurnoverCard[] {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(capturedAt));
  const dates = recentSalesDates(date).reverse();
  const time = new Date(capturedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const totalParts = Math.ceil(rows.length / CARD_ROWS_PER_PAGE);
  return Array.from({ length: totalParts }, (_, index) => ({
    title: "库存周转预警",
    summary: `${warehouse.replace(/[\r\n\t]/g, " ")} · ${time} · 共 ${rows.length} 款 · ${index + 1}/${totalParts}`,
    footer: `均值 > ${threshold} · 周转 < ${TURNOVER_ALERT_DAYS}天 · 净销量含退货，按库存与入库核算`,
    dates, totalCount: rows.length, part: index + 1, totalParts,
    rows: rows.slice(index * CARD_ROWS_PER_PAGE, (index + 1) * CARD_ROWS_PER_PAGE).map(row => ({
      goodsNo: row.goodsNo, goodsName: row.goodsName, unitName: row.unitName, quantity: row.quantity, average: row.metrics?.average7 ?? "—", turnover: row.metrics?.turnoverDays ?? "—",
      sales: dates.map(day => row.sales?.[day] ?? null),
    })),
  }));
}

// The card builder's native Chart accepts { type, data: [{x,y,type}], config }.
// Quantities stay decimal strings in text; only plotting uses JavaScript numbers.
export function nativeCardParams(card: TurnoverCard): Record<string, string> {
  const rows = card.rows.map(row => {
    let segment = 0, afterGap = false;
    const data = card.dates.flatMap((date, index) => {
      const raw = row.sales[index], value = raw == null ? NaN : Number(raw);
      if (raw == null || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) { afterGap = true; return []; }
      if (afterGap) { segment++; afterGap = false; }
      return [{ x: date.slice(5), y: value, type: segment ? `净销量（数据段${segment + 1}）` : "净销量" }];
    });
    // A complete single series needs no grouping field/legend. Gapped series
    // retain separate groups so they never connect across a missing date.
    const chartData = segment === 0 ? data.map(({ x, y }) => ({ x, y })) : data;
    return { goodsNo: row.goodsNo, goodsName: row.goodsName, unitName: row.unitName,
      quantity: row.quantity, average: row.average, turnover: row.turnover,
      chart: { type: "lineChart", data: chartData, config: NATIVE_TREND_CONFIG },
    };
  });
  return { title: card.title, summary: card.summary, footer: card.footer,
    rows: JSON.stringify(rows), config: JSON.stringify({ autoLayout: true }) };
}

export function normalizeCardTemplateId(input: string): string {
  const value = input.trim();
  if (value && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.schema)?$/i.test(value)) throw new Error("钉钉卡片模板 ID 格式无效");
  // The builder may display a UUID; the advanced-card API uses its schema ID.
  return value ? `${value.replace(/\.schema$/i, "")}.schema` : "";
}

export function cardTemplateId(): string {
  return normalizeCardTemplateId(process.env.DINGTALK_CARD_TEMPLATE_ID || "");
}
