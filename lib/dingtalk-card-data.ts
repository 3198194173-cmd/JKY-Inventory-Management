import type { InventoryView } from "./inventory-types";
import { recentSalesDates } from "./inventory-metrics";
import { TURNOVER_ALERT_DAYS } from "./turnover-alert";

export type TurnoverCard = {
  title: string; summary: string; footer: string; dates: string[];
  totalCount: number; part: number; totalParts: number;
  rows: { goodsNo: string; quantity: string; average: string; turnover: string; sales: (string | null)[] }[];
};
export const CARD_ROWS_PER_PAGE = 12;
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
      goodsNo: row.goodsNo, quantity: row.quantity, average: row.metrics?.average7 ?? "—", turnover: row.metrics?.turnoverDays ?? "—",
      sales: dates.map(day => row.sales?.[day] ?? null),
    })),
  }));
}

export function cardTemplateId(): string {
  const value = (process.env.DINGTALK_CARD_TEMPLATE_ID || "").trim();
  if (value && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.schema)?$/i.test(value)) throw new Error("钉钉卡片模板 ID 格式无效");
  return value;
}
