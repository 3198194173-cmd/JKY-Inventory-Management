import { ApiFailure, GATEWAY, jackyunSign, shanghaiTimestamp } from './jackyun';
import { parseLosslessJson } from './lossless-json';
import { sourceWorkbook } from './kingdee-sales-source';

export type PurchaseFlag = '是' | '否' | null;
export function purchaseFlag(value: unknown): PurchaseFlag {
  if (value === true || value === 1 || value === '1' || value === 'true') return '是';
  if (value === false || value === 0 || value === '0' || value === 'false') return '否';
  return null;
}
export type GoodsRecord = { goodsNo: string; goodsName: string; skuId: string; stopPurchasing: PurchaseFlag };
export type GoodsPage = { rows: GoodsRecord[]; total: number | null };
export async function fetchGoodsPage(appkey: string, secret: string, cursor: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<GoodsPage> {
  const params = { appkey, method: 'erp.storage.goodslist', bizcontent: JSON.stringify({ pageIndex: 0, pageSize: 200, maxSkuId: cursor }), contenttype: 'json', version: 'v1.0', timestamp: shanghaiTimestamp() };
  let response: Response;
  try { response = await fetcher(GATEWAY, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: new URLSearchParams({ ...params, sign: jackyunSign(params, secret) }), signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]) }); }
  catch { throw new ApiFailure('吉客云货品查询已停止或网络超时'); }
  if (!response.ok) throw new ApiFailure(`吉客云货品查询HTTP错误（${response.status}）`);
  const reader = response.body?.getReader(); if (!reader) throw new ApiFailure('吉客云返回空响应');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new ApiFailure('货品单页响应超过8MB'); } chunks.push(value); }
  let body: { code?: unknown; subCode?: unknown; result?: { data?: { goods?: unknown } | null; pageInfo?: { total?: unknown }; noPrivilegeItem?: unknown } };
  try { body = parseLosslessJson(Buffer.concat(chunks).toString('utf8')) as typeof body; } catch { throw new ApiFailure('货品响应不是有效JSON'); }
  if (Number(body.code) !== 200) throw new ApiFailure('货品查询失败，错误码：' + String(body.subCode ?? body.code).replace(/[^\w-]/g, '').slice(0, 40));
  const privilege = body.result?.noPrivilegeItem;
  if (privilege != null && !['', '[]', '{}'].includes(typeof privilege === 'object' ? JSON.stringify(privilege) : String(privilege))) throw new ApiFailure('货品查询存在权限受限字段，未发布');
  const raw = body.result?.data === null && String(body.subCode) === '0250000004' ? [] : body.result?.data?.goods;
  if (!Array.isArray(raw) || raw.length > 200) throw new ApiFailure('货品响应缺少goods数组或超出页大小');
  const rows = raw.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiFailure('货品记录格式异常');
    const row = value as Record<string, unknown>;
    if (typeof row.goodsNo !== 'string' || !row.goodsNo.trim() || typeof row.goodsName !== 'string' || !/^\d+$/.test(String(row.skuId))) throw new ApiFailure('货品记录缺少编码、名称或规格内码');
    return { goodsNo: row.goodsNo.trim(), goodsName: row.goodsName, skuId: String(row.skuId), stopPurchasing: purchaseFlag(row.isStopPurchasing) };
  });
  const totalValue = body.result?.pageInfo?.total;
  const total = totalValue != null && /^\d+$/.test(String(totalValue)) && Number.isSafeInteger(Number(totalValue)) ? Number(totalValue) : null;
  return { rows, total };
}

// Raw source adapter shared with the runtime import pipeline. All cells are text,
// so identifiers and strings beginning '=' cannot be interpreted as formulas.
export function flatSourceWorkbook(headers: string[], rows: (string | null)[][], name: string) {
  const escape = (value: string) => value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const column = (index: number): string => index < 26 ? String.fromCharCode(65 + index) : column(Math.floor(index / 26) - 1) + String.fromCharCode(65 + index % 26);
  return sourceWorkbook([headers, ...rows].map((row, i) => `<row r="${i + 1}">${row.map((value, j) => `<c r="${column(j)}${i + 1}" t="inlineStr"><is><t xml:space="preserve">${escape(value ?? '')}</t></is></c>`).join('')}</row>`), name);
}

export function mergePurchaseFlags(rows: { flag: PurchaseFlag }[]): PurchaseFlag {
  if (!rows.length || rows.some(row => row.flag === null)) return null;
  return rows.every(row => row.flag === rows[0].flag) ? rows[0].flag : null;
}
