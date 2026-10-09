import sharp from "sharp";
import { init } from "./echarts-runtime";
import { salesTrendOption } from "./sales-trend";
import { transitText, replenishmentText, type TurnoverCard } from "./dingtalk-card-data";

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
function text(x: number, y: number, value: string, options = "") {
  return `<text x="${x}" y="${y}" ${options}>${escape(value)}</text>`;
}
export function turnoverCardSvg(card: TurnoverCard): string {
  const width = 1200, rowHeight = 76, top = 130, height = top + card.rows.length * rowHeight + 68;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect width="100%" height="100%" rx="16" fill="#fff"/>',
    '<g font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif" fill="#253655" font-size="18">',
    text(24, 42, card.title, 'font-size="28" font-weight="bold"'),
    text(24, 78, card.summary, 'font-size="18" fill="#64748b"'),
    '<rect x="16" y="92" width="1168" height="38" rx="5" fill="#eef3ff"/>',
    text(30, 118, "商品编码 / 名称", 'font-size="20"'), text(420, 118, "库存", 'text-anchor="end" font-size="20"'),
    text(530, 118, "销售均值", 'text-anchor="end" font-size="20"'), text(635, 118, "周转(天)", 'text-anchor="end" font-size="20"'),
    text(740, 118, "在途数量", 'text-anchor="end" font-size="18"'), text(910, 118, "建议补货 / 30天", 'text-anchor="end" font-size="18"'),
    text(1055, 118, "近7天销量", 'text-anchor="middle" font-size="20"'),
  ];
  card.rows.forEach((row, index) => {
    const y = top + index * rowHeight;
    if (index % 2 === 1) parts.push(`<rect x="16" y="${y}" width="1168" height="${rowHeight}" fill="#f7f9fd"/>`);
    parts.push(text(30, y + 30, row.goodsNo, 'font-size="17"'+(row.goodsNo.length>28 ? ' textLength="300" lengthAdjust="spacingAndGlyphs"' : '')),
      text(30, y + 55, row.goodsName.length>25 ? row.goodsName.slice(0,25)+"…" : row.goodsName, 'font-size="13"'),
      text(420, y + 44, row.quantity, 'text-anchor="end"'), text(530, y + 44, row.average, 'text-anchor="end"'),
      text(635, y + 44, row.turnover, 'text-anchor="end" fill="#dc2626" font-weight="bold"'),
      text(740, y + 44, transitText(row), 'text-anchor="end"'), text(910, y + 44, replenishmentText(row), 'text-anchor="end"'));
    const chart = init(null, undefined, { renderer: "svg", ssr: true, width: 240, height: 66 });
    try {
      const option = salesTrendOption(card.dates.map((date, i) => ({ date, value: row.sales[i] })), true);
      option.tooltip = { show: false };
      chart.setOption(option);
      // Prefix SVG IDs so multiple independent ECharts plots cannot share clip paths.
      const svg = chart.renderToSVGString().replace(/\bid="([^"]+)"/g, (_, id) => `id="row${index}-${id}"`).replace(/url\(#([^)]+)\)/g, (_, id) => `url(#row${index}-${id})`);
      parts.push(`<g transform="translate(936,${y + 5})">${svg}</g>`);
    } finally { chart.dispose(); }
    parts.push(`<line x1="24" y1="${y + rowHeight}" x2="1176" y2="${y + rowHeight}" stroke="#e5eaf3"/>`);
  });
  const footerY = top + card.rows.length * rowHeight;
  parts.push(text(936, footerY + 24, card.dates[0]?.slice(5) || "", 'font-size="16" fill="#64748b"'),
    text(1160, footerY + 24, card.dates.at(-1)?.slice(5) || "", 'font-size="16" fill="#64748b" text-anchor="end"'),
    text(24, footerY + 54, card.footer, 'font-size="17" fill="#64748b"'), '</g></svg>');
  return parts.join("");
}
export async function renderTurnoverCard(card: TurnoverCard): Promise<Buffer> {
  return sharp(Buffer.from(turnoverCardSvg(card))).png().toBuffer();
}
