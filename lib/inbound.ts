import { addQuantity, compareQuantity, normalizeQuantity } from "./decimal";
import { ApiFailure, GATEWAY, jackyunSign, shanghaiTimestamp } from "./jackyun";
import { parseLosslessJson } from "./lossless-json";

export type InboundRecord = {
  recId: string; docId: string; documentNo: string; goodsNo: string;
  warehouseCode: string; skuBarcode: string; quantity: string; unitName: string;
  inOutDate: string; createdAt: string | null; typeName: string;
};
export type InboundReconciliation = {
  date: string; rawDifference: string; inboundQuantity: string | null; correctedQuantity: string | null;
  openingQuantity: string; closingQuantity: string;
  status: "verified" | "unresolved" | "failed";
  windowStart: string; windowEnd: string; records: InboundRecord[]; error: string | null; checkedAt: string;
};
export type InboundQuery = { warehouseCode: string; goodsNo?: string; unitName?: string; start: string; end: string };
const COLS = "recId,docId,goodsdocNo,goodsNo,skuBarcode,warehouseCode,inOutDate,gmtCreate,quantity,unitName,inouttypeName";
const PAGE_SIZE = 50;

export function inboundTime(value: unknown): string {
  const text = String(value ?? "");
  let milliseconds: number;
  if (/^\d{13}$/.test(text)) milliseconds = Number(text);
  else if (/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(text)) milliseconds = Date.parse(text.replace(" ", "T") + "+08:00");
  else if (/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(text)) milliseconds = Date.parse(text);
  else throw new ApiFailure("入库记录缺少有效入库时间");
  if (!Number.isFinite(milliseconds)) throw new ApiFailure("入库记录的时间无效");
  return new Date(milliseconds).toISOString();
}

export async function collectInbound(appkey: string, secret: string, query: InboundQuery, fetcher: typeof fetch = fetch, onPage: () => Promise<void> = async () => {}) {
  const start = Date.parse(query.start), end = Date.parse(query.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new ApiFailure("入库核验的采集时间范围无效");
  const records = new Map<string, InboundRecord>();
  // Both active and archived documents are necessary for a complete historical query.
  for (const archived of [0, 1]) {
    const seen = new Set<string>();
    let ended = false;
    for (let pageIndex = 0; pageIndex < 2000; pageIndex++) {
      const bizcontent = JSON.stringify({ warehouseCode: query.warehouseCode, ...(query.goodsNo ? { goodsNo: query.goodsNo } : {}),
        inOutDateStart: shanghaiTimestamp(new Date(Math.floor(start / 1000) * 1000)),
        inOutDateEnd: shanghaiTimestamp(new Date(Math.ceil(end / 1000) * 1000)),
        archived, pageIndex, pageSize: PAGE_SIZE, cols: COLS });
      let response: Response | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        const params = { appkey, bizcontent, contenttype: "json", method: "erp-busiorder.goodsdocin.search", timestamp: shanghaiTimestamp(), version: "v1.0" };
        try {
          response = await fetcher(GATEWAY, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: new URLSearchParams({ ...params, sign: jackyunSign(params, secret) }), signal: AbortSignal.timeout(25_000) });
        } catch { response = undefined; }
        await onPage();
        if (response && response.status !== 429 && response.status < 500) break;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
      }
      if (!response?.ok) throw new ApiFailure(response ? `入库查询失败（HTTP ${response.status}）` : "入库查询网络超时或连接失败");
      let body: { code?: unknown; subCode?: unknown; result?: { data?: unknown; noPrivilegeItem?: unknown } };
      try { body = parseLosslessJson(await response.text()) as typeof body; } catch { throw new ApiFailure("入库接口返回非 JSON 数据，请稍后重试"); }
      if (Number(body.code) !== 200) throw new ApiFailure(`入库查询业务失败（错误码 ${String(body.subCode ?? body.code).replace(/[^\w-]/g, "").slice(0, 30)}），请检查接口订阅和权限`);
      const privilege = body.result?.noPrivilegeItem;
      if (privilege != null && privilege !== "" && JSON.stringify(privilege) !== "[]" && JSON.stringify(privilege) !== "{}") throw new ApiFailure("入库响应存在权限受限字段，无法完成核验");
      const data = body.result?.data;
      // Live nonempty responses also carry subCode 0250000004: inspect data, never subCode alone.
      if (!Array.isArray(data) || data.length > PAGE_SIZE) throw new ApiFailure("入库响应缺少有效分页数组");
      if (!data.length) { ended = true; break; }
      let fresh = 0;
      for (const value of data) {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiFailure("入库记录格式无效");
        const row = value as Record<string, unknown>;
        const goodsNo = String(row.goodsNo ?? "");
        if (String(row.warehouseCode ?? "") !== query.warehouseCode || !goodsNo || (query.goodsNo && goodsNo !== query.goodsNo)) throw new ApiFailure("入库接口返回其他仓库或无效货品，未采用本次结果");
        const recId = String(row.recId ?? "");
        if (!recId || !String(row.goodsdocNo ?? "")) throw new ApiFailure("入库记录缺少明细身份或单号");
        const record: InboundRecord = { recId, docId: String(row.docId ?? ""), documentNo: String(row.goodsdocNo), goodsNo,
          warehouseCode: query.warehouseCode, skuBarcode: String(row.skuBarcode ?? ""), quantity: normalizeQuantity(row.quantity), unitName: String(row.unitName ?? ""),
          inOutDate: inboundTime(row.inOutDate), createdAt: row.gmtCreate == null ? null : inboundTime(row.gmtCreate), typeName: String(row.inouttypeName ?? "入库") };
        const previous = records.get(recId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new ApiFailure("同一入库明细返回冲突数据，无法完成核验");
        if (!seen.has(recId)) { fresh++; seen.add(recId); }
        records.set(recId, record);
      }
      if (!fresh) throw new ApiFailure("入库分页完全重复，已停止以防漏记或重复累计");
    }
    if (!ended) throw new ApiFailure("入库查询超过2000页，结果不完整，未修正销量");
  }
  // The request widens to whole seconds; apply exact snapshot boundaries locally.
  const selected = [...records.values()].filter(row => Date.parse(row.inOutDate) > start && Date.parse(row.inOutDate) <= end);
  if (query.unitName && selected.some(row => row.unitName !== query.unitName)) throw new ApiFailure("入库数量单位与库存单位不一致，未直接换算");
  // A warehouse may contain different units; aggregate only after grouping by goods.
  const total = query.goodsNo ? selected.reduce((sum, row) => addQuantity(sum, row.quantity), "0") : "0";
  if (query.goodsNo && compareQuantity(total, "0") < 0) throw new ApiFailure("入库合计为负，需核对冲销记录");
  return { quantity: total, records: selected.sort((a,b) => a.inOutDate.localeCompare(b.inOutDate) || a.recId.localeCompare(b.recId)) };
}
