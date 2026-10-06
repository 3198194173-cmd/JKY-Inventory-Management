import { createHash } from "node:crypto";
import { compareQuantity, normalizeQuantity } from "./decimal";
import type { StockRow } from "./inventory-types";
import { WAREHOUSE_NAME } from "./jackyun";
import type { InventoryView } from "./inventory-types";
import { turnoverAlert, TURNOVER_ALERT_DAYS } from "./turnover-alert";

export type RobotCredentials = { clientId: string; clientSecret: string; robotCode: string; openConversationId: string };
let tokenCache: { clientId: string; secretDigest: string; token: string; expiresAt: number } | null = null;

export function alertRows(rows: StockRow[], threshold: string) {
  const normalized = normalizeQuantity(threshold);
  return rows.filter(row => compareQuantity(row.quantity, normalized) <= 0);
}

export function alertDigest(rows: StockRow[], threshold: string) {
  return createHash("sha256").update(JSON.stringify({ threshold, rows: rows.map(r => [r.goodsNo, r.quantity, r.unitName]).sort((a,b) => a[0].localeCompare(b[0])) })).digest("hex");
}

export function alertMessage(rows: StockRow[], threshold: string, capturedAt: string) {
  const lines = rows.slice(0, 20).map(r => `${r.goodsNo} · ${r.goodsName.slice(0,48)}：${r.quantity} ${r.unitName}`);
  return [`【仓库库存预警】${WAREHOUSE_NAME}`, `采集时间：${capturedAt}`, `可订购量 ≤ ${threshold}：${rows.length} 个货品`, ...lines, ...(rows.length > 20 ? [`另有 ${rows.length - 20} 个货品，请打开库存分析网页查看。`] : []), "口径：完整库存采集后的可订购量；未接入在途数量。"].join("\n");
}

export function turnoverAlertRows(rows: InventoryView["rows"], threshold: string) {
  return rows.filter(row=>turnoverAlert(row.metrics,row.quantity,threshold))
    .sort((a,b)=>compareQuantity(a.metrics!.turnoverDays!,b.metrics!.turnoverDays!) || a.goodsNo.localeCompare(b.goodsNo));
}
const cleanLine = (value: string, length: number) => Array.from(value.replace(/[\r\n\t]+/g," ")).slice(0,length).join("");
export function turnoverAlertMessage(rows: InventoryView["rows"], threshold: string, warehouse: string, capturedAt: string) {
  const time = new Date(capturedAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false});
  return [`【库存周转预警】${cleanLine(warehouse,80)}`,`${time} · 共 ${rows.length} 款`,
    `销量均值 > ${threshold}，周转 < ${TURNOVER_ALERT_DAYS} 天`,
    ...rows.slice(0,5).map(r=>`${cleanLine(r.goodsNo,60)} ${cleanLine(r.goodsName,16)}｜库存 ${r.quantity} · ${r.metrics!.turnoverDays}天`),
    ...(rows.length>5?[`其余 ${rows.length-5} 款请查看库存页标红项。`]:[]),"按库存净消耗估算。"].join("\n");
}

async function responseJson(response: Response): Promise<Record<string,unknown>> {
  if (!response.ok) throw new Error(`钉钉机器人请求失败（HTTP ${response.status}），请核对应用权限、机器人发布状态和目标群`);
  try { return await response.json(); } catch { throw new Error("钉钉响应格式异常"); }
}

export async function appAccessToken(credentials: Pick<RobotCredentials, "clientId" | "clientSecret">, fetcher: typeof fetch = fetch): Promise<string> {
  const secretDigest = createHash("sha256").update(credentials.clientSecret).digest("hex");
  const cached = tokenCache && tokenCache.clientId === credentials.clientId && tokenCache.secretDigest === secretDigest && tokenCache.expiresAt > Date.now() ? tokenCache : null;
  let token = cached?.token;
  if (!token) {
    const response = await fetcher("https://api.dingtalk.com/v1.0/oauth2/accessToken", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appKey: credentials.clientId, appSecret: credentials.clientSecret }), signal: AbortSignal.timeout(15_000) });
    const data = await responseJson(response);
    if (typeof data.accessToken !== "string" || !Number.isFinite(Number(data.expireIn))) throw new Error("未取得钉钉应用访问令牌，请检查机器人应用凭证");
    token = data.accessToken;
    tokenCache = { clientId: credentials.clientId, secretDigest, token, expiresAt: Date.now() + Math.max(0, Number(data.expireIn) - 120) * 1000 };
  }
  return token;
}

export async function sendRobotMessage(credentials: RobotCredentials, message: string, fetcher: typeof fetch = fetch): Promise<string> {
  const token = await appAccessToken(credentials, fetcher);
  // No automatic retries: an uncertain response could already have sent a message.
  const response = await fetcher("https://api.dingtalk.com/v1.0/robot/groupMessages/send", { method: "POST", headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": token }, body: JSON.stringify({ robotCode: credentials.robotCode, openConversationId: credentials.openConversationId, msgKey: "sampleText", msgParam: JSON.stringify({ content: message }) }), signal: AbortSignal.timeout(15_000) });
  const data = await responseJson(response);
  if (typeof data.processQueryKey !== "string" || !data.processQueryKey) throw new Error("钉钉未确认消息受理，请在群中核对；本次不会自动重发");
  return data.processQueryKey;
}
