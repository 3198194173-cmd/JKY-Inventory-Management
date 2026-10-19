import { ApiFailure, GATEWAY, jackyunSign, shanghaiTimestamp } from './jackyun';
import { parseLosslessJson } from './lossless-json';

export type AvailableWarehouse = { code: string; name: string; warehouseId: string };
export const WAREHOUSE_PAGE_SIZE = 50;
// Official docs: 仓储类 → 仓库 → 开放平台仓库查询 (erp.warehouse.get).
// Unlike stock APIs this returns warehouses even when they have no SKU stock.
export async function discoverWarehouses(appkey: string, secret: string, fetcher: typeof fetch = fetch): Promise<AvailableWarehouse[]> {
  const warehouses: AvailableWarehouse[] = [], codes = new Set<string>(), ids = new Set<string>();
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    const params = { appkey, bizcontent: JSON.stringify({ pageIndex, pageSize: WAREHOUSE_PAGE_SIZE, includeDeleteAndBlockup: 0 }), contenttype: 'json', method: 'erp.warehouse.get', timestamp: shanghaiTimestamp(), version: 'v1.0' };
    let body: { code?: unknown; subCode?: unknown; result?: { data?: { warehouseInfo?: unknown }; noPrivilegeItem?: unknown } } | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await fetcher(GATEWAY, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: new URLSearchParams({ ...params, sign: jackyunSign(params, secret) }), signal: AbortSignal.timeout(25_000), cache: 'no-store' });
      } catch {
        if (attempt < 2) { await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt)); continue; }
        throw new ApiFailure('吉客云仓库列表连接超时，请重试');
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) { await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt)); continue; }
      if (!response.ok) throw new ApiFailure(`吉客云仓库列表请求失败（HTTP ${response.status}）`);
      try { body = parseLosslessJson(await response.text()) as typeof body; }
      catch { throw new ApiFailure('吉客云仓库列表不是有效 JSON'); }
      break;
    }
    if (!body || Number(body.code) !== 200) {
      const code = String(body?.subCode ?? body?.code ?? '').replace(/[^\w-]/g, '').slice(0, 30);
      // Never echo upstream error text: it may contain signed parameters.
      throw new ApiFailure(`无法读取吉客云仓库列表（错误码 ${code}）。请管理员检查应用是否已订阅并获授权调用 erp.warehouse.get`);
    }
    const privilege = body.result?.noPrivilegeItem;
    if (privilege != null && privilege !== '' && !['[]', '{}'].includes(JSON.stringify(privilege))) throw new ApiFailure('仓库列表包含权限受限字段，未使用不完整列表');
    const rows = body.result?.data?.warehouseInfo;
    if (!Array.isArray(rows) || rows.length > WAREHOUSE_PAGE_SIZE) throw new ApiFailure('吉客云仓库列表缺少有效 warehouseInfo 数组或超过页大小');
    if (!rows.length) return warehouses.sort((a, b) => a.code.localeCompare(b.code, 'zh-CN', { numeric: true }));
    for (const value of rows) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiFailure('仓库列表记录格式无效');
      const row = value as Record<string, unknown>;
      const code = typeof row.warehouseCode === 'string' ? row.warehouseCode.trim() : '';
      const name = typeof row.warehouseName === 'string' ? row.warehouseName.trim() : '';
      const id = typeof row.warehouseId === 'string' ? row.warehouseId.trim() : '';
      if (!/^[A-Za-z0-9_.-]{1,50}$/.test(code) || !name || name.length > 80 || !/^\d+$/.test(id)) throw new ApiFailure('仓库编码、名称或 ID 格式无效，未使用不完整列表');
      if (codes.has(code) || ids.has(id)) throw new ApiFailure('仓库列表分页出现重复编码或 ID，请刷新重试');
      codes.add(code); ids.add(id);
      // Filter defensively as well as requesting active records server-side.
      if (row.isDelete === true || String(row.isDelete) === '1' || row.isBlockup === true || String(row.isBlockup) === '1') continue;
      warehouses.push({ code, name, warehouseId: id });
    }
    // Read the next page even after a short page; a gateway page cap must not
    // silently truncate discovery. An explicit empty array ends pagination.
  }
  throw new ApiFailure('仓库列表超过 100 页保护上限，未使用截断列表');
}
