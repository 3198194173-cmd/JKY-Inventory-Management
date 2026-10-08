import { createHmac, timingSafeEqual } from "node:crypto";
import sharp from "sharp";
import { init } from "./echarts-runtime";
import { salesTrendOption, type TrendSample } from "./sales-trend";
import type { TurnoverCard } from "./dingtalk-card-data";

const signature = (payload: string, secret: string) => createHmac("sha256", secret).update("inventory-trend-v1:" + payload).digest();

// These messages contain only our own validation hints, never request data.
export class TrendThumbnailError extends Error {}

function samplesFromPayload(value: unknown): TrendSample[] {
  if (!Array.isArray(value) || value.length !== 7) throw new TrendThumbnailError("无效趋势数据");
  const samples = value.map((item: unknown) => {
    if (!Array.isArray(item) || item.length !== 2) throw new TrendThumbnailError("无效趋势数据");
    const [date, raw] = item;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + "T00:00:00Z"))) throw new TrendThumbnailError("无效趋势日期");
    if (raw !== null && (typeof raw !== "string" || raw.length > 40 || !/^-?\d+(?:\.\d+)?$/.test(raw))) throw new TrendThumbnailError("无效趋势数值");
    const number = raw === null ? null : Number(raw);
    return { date, value: number !== null && Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? raw as string : null };
  });
  if (samples.some((sample, i) => i > 0 && Date.parse(sample.date) - Date.parse(samples[i - 1].date) !== 86400000)) throw new TrendThumbnailError("无效趋势日期");
  return samples;
}

export function trendThumbnailUrls(card: TurnoverCard, siteUrl: string, secret: string): string[] {
  if (!secret) throw new TrendThumbnailError("缺少趋势图签名配置，请检查 DINGTALK_CLIENT_SECRET");
  let base: URL;
  const addressHint = "请将云端 INVENTORY_SITE_URL 配置为可公开访问的 HTTPS 库存网站地址（不能使用 localhost 或 HTTP），并重建 web、worker 容器";
  try { base = new URL(siteUrl.trim()); } catch { throw new TrendThumbnailError(addressHint); }
  if (base.protocol !== "https:" || base.username || base.password || /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(base.hostname)) throw new TrendThumbnailError(addressHint);
  return card.rows.map(row => {
    const samples = samplesFromPayload(card.dates.map((date, i) => [date, row.sales[i] ?? null]));
    // Only seven dates and sales are included. No account, product or inventory fields.
    const payload = Buffer.from(JSON.stringify(samples.map(s => [s.date, s.value]))).toString("base64url");
    const token = `${payload}.${signature(payload, secret).toString("base64url")}`;
    return new URL(`/api/alerts/trend/${token}`, base).href;
  });
}

export function verifyTrendThumbnail(token: string, secret: string): TrendSample[] | null {
  if (!secret || token.length > 2048 || !/^[\w-]+\.[\w-]+$/.test(token)) return null;
  try {
    const [payload, mac] = token.split("."), expected = signature(payload, secret), received = Buffer.from(mac, "base64url");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
    return samplesFromPayload(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch { return null; }
}

export function trendThumbnailSvg(samples: TrendSample[]): string {
  const chart = init(null, undefined, { renderer: "svg", ssr: true, width: 640, height: 180 });
  try {
    const option = salesTrendOption(samples, true);
    option.tooltip = { show: false };
    option.grid = { left: 10, right: 10, top: 10, bottom: 10 };
    option.series = [{ name: "净销量", type: "line", smooth: true, connectNulls: false, symbol: "emptyCircle", symbolSize: 7, lineStyle: { width: 3 }, data: samples.map(s => s.value === null ? null : Number(s.value)) }];
    chart.setOption(option);
    return chart.renderToSVGString();
  } finally { chart.dispose(); }
}

export async function renderTrendThumbnail(samples: TrendSample[]): Promise<Buffer> {
  return sharp(Buffer.from(trendThumbnailSvg(samples))).png().toBuffer();
}

export function trendDetailHtml(samples: TrendSample[]): string {
  const chart = init(null, undefined, { renderer: "svg", ssr: true, width: 640, height: 340 });
  let svg: string;
  try {
    const option = salesTrendOption(samples);
    option.tooltip = { show: false };
    chart.setOption(option);
    svg = chart.renderToSVGString();
  } finally { chart.dispose(); }
  // Values/date strings are validated above; the document includes no inventory fields.
  const buttons = samples.map((s, i) => `<button type="button" data-index="${i}" data-date="${s.date}" data-value="${s.value ?? "暂无数据"}" aria-pressed="false"><span>${s.date.slice(5)}</span><strong>${s.value ?? "—"}</strong></button>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>近7天净销量趋势</title><style>
  *{box-sizing:border-box}body{margin:0;padding:20px 12px;background:#fff;color:#334155;font:14px system-ui,sans-serif}h1{font-size:18px;margin:0 0 8px}.hint{color:#8090a5;font-size:12px;margin:0 0 18px}svg{width:100%;height:auto;display:block}.days{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px;margin-top:14px}button{border:1px solid #edf0f6;border-radius:6px;background:#f8faff;color:#334155;padding:8px 2px;font:12px system-ui;overflow-wrap:anywhere}button span,button strong{display:block}button strong{margin-top:6px}button[aria-pressed=true]{border-color:#5278d8;background:#edf3ff;color:#2459bd}output{display:block;min-height:24px;color:#2459bd;margin-top:16px;text-align:center}
  </style></head><body><h1>近7天净销量趋势</h1><p class="hint">点击日期或数据点查看数值 · 缺失日期不补零</p>${svg}<div class="days">${buttons}</div><output aria-live="polite">请选择日期</output><script>
  function selectDay(index){const buttons=[...document.querySelectorAll('button')],button=buttons[index];if(!button)return;buttons.forEach(b=>b.setAttribute('aria-pressed',String(b===button)));document.querySelector('output').textContent=button.dataset.date+' · 净销量 '+button.dataset.value;}
  document.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>selectDay(Number(b.dataset.index))));document.querySelector('svg').addEventListener('click',e=>{const point=e.target.closest('[ecmeta_data_index]');if(point)selectDay(Number(point.getAttribute('ecmeta_data_index')));});
  </script></body></html>`;
}
