import { env } from "cloudflare:workers";
import { compareQuantity } from "./decimal";
import { shanghaiTimestamp, WAREHOUSE_CODE, WAREHOUSE_NAME } from "./jackyun";
import { summarizeRows } from "./sample";
import { serverConfig } from "./server-config";
import { comparableDates, dailySales } from "./daily-sales";
import type { InventoryView, RunInfo, SnapshotInfo, StockRow, WarehouseInfo } from "./inventory-types";
import type { ScopeInfo } from "./stock-scope";

export function database(): D1Database {
  if (!env.DB) throw new Error("库存数据存储尚未配置");
  return env.DB;
}
export function warehouseCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,50}$/.test(value.trim())) throw new Error("仓库编码须为 1 至 50 位字母、数字、点、横线或下划线");
  return value.trim();
}
type WarehouseRecord = { code: string; name: string; warehouse_id: string | null; daily_time: string; time_zone: string };
const mapWarehouse = (w: WarehouseRecord): WarehouseInfo => ({ code: w.code, name: w.name, warehouseId: w.warehouse_id, dailyTime: w.daily_time, timeZone: w.time_zone });
export async function loadWarehouses(owner: string): Promise<WarehouseInfo[]> {
  const db = database();
  await db.prepare("INSERT OR IGNORE INTO warehouses (owner, code, name, warehouse_id, created_at) VALUES (?, ?, ?, ?, ?)").bind(owner, WAREHOUSE_CODE, WAREHOUSE_NAME, "2391620541187785472", new Date().toISOString()).run();
  const result = await db.prepare("SELECT * FROM warehouses WHERE owner = ? ORDER BY created_at, code").bind(owner).all<WarehouseRecord>();
  return result.results.map(mapWarehouse);
}
export async function addWarehouse(owner: string, code: unknown, name: unknown) {
  const validated = warehouseCode(code), label = typeof name === "string" ? name.trim() : "";
  if (label.length > 80) throw new Error("仓库名称最多 80 字");
  await loadWarehouses(owner);
  await database().prepare("INSERT OR IGNORE INTO warehouses (owner, code, name, created_at) VALUES (?, ?, ?, ?)").bind(owner, validated, label || validated, new Date().toISOString()).run();
  return loadWarehouses(owner);
}
export async function requireWarehouse(owner: string, code: string) {
  const warehouse = (await loadWarehouses(owner)).find(w => w.code === warehouseCode(code));
  if (!warehouse) throw new Error("请先增加该仓库");
  return warehouse;
}
type SnapshotRecord = { id: string; date: string; captured_at: string; page_count: number; record_count: number; goods_count: number; totals: string; zero_count: number; negative_count: number; scope_key: string; scope_label: string; scope_count: number };
type EntryRecord = { goods_no: string; goods_name: string; unit_name: string; quantity: string; sku_count: number; date?: string };
const mapSnapshot = (s: SnapshotRecord): SnapshotInfo => ({ id: s.id, date: s.date, capturedAt: s.captured_at, pageCount: s.page_count, recordCount: s.record_count, source: "live", scope: { key: s.scope_key, label: s.scope_label, count: s.scope_count } });
const mapEntry = (r: EntryRecord): StockRow => ({ goodsNo: r.goods_no, goodsName: r.goods_name, unitName: r.unit_name, quantity: r.quantity, skuCount: r.sku_count });

export async function loadInventory(owner: string, query: { source?: string; warehouseCode?: string; q?: string; filter?: string; days?: number; page?: number; pageSize?: number; sort?: string } = {}): Promise<InventoryView> {
  const config = serverConfig(), warehouses = await loadWarehouses(owner);
  const warehouse = warehouses.find(w => w.code === (query.warehouseCode || WAREHOUSE_CODE));
  if (!warehouse) throw new Error("仓库尚未添加");
  const days = [7,14,30].includes(query.days || 0) ? query.days! : 14;
  const requestedPage = Math.max(1, Math.floor(query.page || 1)), pageSize = [100,200,500,1000].includes(query.pageSize || 0) ? query.pageSize! : 100;
  const latest = await database().prepare("SELECT * FROM stock_snapshots WHERE owner = ? AND warehouse_code = ? AND coverage = 'auto:v1' AND status = 'complete' ORDER BY captured_at DESC, id DESC LIMIT 1").bind(owner, warehouse.code).first<SnapshotRecord>();
  const base = { warehouseCode: warehouse.code, warehouseName: warehouse.name, warehouses, source: "live" as const, configured: config.configured, robotConfigured: config.robotConfigured, scheduleActive: false, dailyTime: "08:00", pageSize };
  if (!latest) return { ...base, snapshot: null, snapshots: [], salesDates: [], rows: [], totalRows: 0, goodsCount: 0, page: 1, totalsByUnit: {}, zeroCount: 0, negativeCount: 0 };
  const records = await database().prepare("SELECT s.* FROM daily_slots d JOIN stock_snapshots s ON s.id = d.snapshot_id WHERE d.owner = ? AND d.warehouse_code = ? AND s.coverage = 'auto:v1' AND s.status = 'complete' ORDER BY d.date DESC LIMIT 31").bind(owner, warehouse.code).all<SnapshotRecord>();
  const lower = new Date(latest.date + "T00:00:00Z"); lower.setUTCDate(lower.getUTCDate() - days);
  const daily = records.results.filter(r => r.date >= lower.toISOString().slice(0,10));
  const salesDates = comparableDates(daily.map(r => r.date));
  const parameters: (string | number)[] = [latest.id];
  let where = "snapshot_id = ?";
  if (query.q) { where += " AND (instr(lower(goods_no), ?) > 0 OR instr(lower(goods_name), ?) > 0)"; parameters.push(query.q.toLowerCase(), query.q.toLowerCase()); }
  if (query.filter === "zero") where += " AND sign = 0";
  if (query.filter === "negative") where += " AND sign < 0";
  if (query.filter === "positive") where += " AND sign > 0";
  const count = await database().prepare(`SELECT COUNT(*) AS count FROM stock_entries WHERE ${where}`).bind(...parameters).first<{ count: number }>();
  const totalRows = count?.count || 0, page = Math.min(requestedPage, Math.max(1, Math.ceil(totalRows / pageSize)));
  const asc = query.sort === "quantity_asc", desc = query.sort === "quantity_desc" || query.sort === "quantity";
  // Normalized decimal strings sort exactly, including quantities beyond REAL precision.
  const sort = asc || desc ? `sign ${asc ? "ASC" : "DESC"}, CASE WHEN sign > 0 THEN instr(quantity || '.', '.') - 1 WHEN sign < 0 THEN 2 - instr(quantity || '.', '.') ELSE 0 END ${asc ? "ASC" : "DESC"}, CASE WHEN sign > 0 THEN quantity END COLLATE BINARY ${asc ? "ASC" : "DESC"}, CASE WHEN sign < 0 THEN substr(quantity, 2) END COLLATE BINARY ${asc ? "DESC" : "ASC"}, goods_no COLLATE BINARY ASC` : "goods_no COLLATE BINARY ASC";
  const result = await database().prepare(`SELECT * FROM stock_entries WHERE ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`).bind(...parameters, pageSize, (page - 1) * pageSize).all<EntryRecord>();
  const history = new Map<string, EntryRecord[]>();
  if (result.results.length && daily.length) {
    // Three bindings even with a 1,000-row page; D1 limits bound variables to 100.
    const values = await database().prepare("SELECT e.goods_no, e.quantity, e.unit_name, s.date FROM stock_entries e JOIN stock_snapshots s ON s.id = e.snapshot_id WHERE s.owner = ? AND e.snapshot_id IN (SELECT value FROM json_each(?)) AND e.goods_no IN (SELECT value FROM json_each(?))").bind(owner, JSON.stringify(daily.map(s => s.id)), JSON.stringify(result.results.map(r => r.goods_no))).all<EntryRecord>();
    for (const row of values.results) { const list = history.get(row.goods_no) || []; list.push(row); history.set(row.goods_no, list); }
  }
  return { ...base, snapshot: mapSnapshot(latest), snapshots: daily.map(mapSnapshot), salesDates, rows: result.results.map(r => {
    const values = history.get(r.goods_no) || [];
    return { ...mapEntry(r), history: Object.fromEntries(values.map(v => [v.date!, v.quantity])), sales: dailySales(values.map(v => ({ date: v.date!, quantity: v.quantity, unitName: v.unit_name })), salesDates, r.unit_name) };
  }), totalRows, goodsCount: latest.goods_count, page, totalsByUnit: JSON.parse(latest.totals), zeroCount: latest.zero_count, negativeCount: latest.negative_count };
}

export async function acquireRun(owner: string, code = WAREHOUSE_CODE, trigger = "manual"): Promise<string> {
  const db = database(), now = new Date().toISOString(), cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  await db.prepare("UPDATE sync_runs SET status = 'failed', completed_at = ?, message = '采集超过十分钟，已解除锁定；请重试' WHERE owner = ? AND warehouse_code = ? AND status = 'running' AND started_at < ?").bind(now, owner, code, cutoff).run();
  const id = crypto.randomUUID();
  const result = await db.prepare("INSERT INTO sync_runs (id, owner, status, started_at, warehouse_code, trigger) SELECT ?, ?, 'running', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM sync_runs WHERE owner = ? AND warehouse_code = ? AND status = 'running')").bind(id, owner, now, code, trigger, owner, code).run();
  if (!result.meta.changes) throw new Error("该仓库已有库存采集正在进行，请等待完成");
  return id;
}
export async function updateRun(id: string, pages: number, records: number, goods: number) {
  await database().prepare("UPDATE sync_runs SET page_count = ?, record_count = ?, goods_count = ? WHERE id = ? AND status = 'running'").bind(pages, records, goods, id).run();
}
export async function publishSnapshot(owner: string, id: string, rows: StockRow[], pageCount: number, recordCount: number, duplicateCount: number, scope: ScopeInfo, warehouse: { code: string; name: string; id: string; hash: string }) {
  const db = database(), capturedDate = new Date(), captured = capturedDate.toISOString(), localTime = shanghaiTimestamp(capturedDate), date = localTime.slice(0,10), summary = summarizeRows(rows);
  await db.prepare("INSERT INTO stock_snapshots (id, owner, date, captured_at, status, page_count, record_count, goods_count, totals, zero_count, negative_count, scope_key, scope_label, scope_count, warehouse_code, warehouse_name, coverage, catalog_hash) VALUES (?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto:v1', ?)").bind(id, owner, date, captured, pageCount, recordCount, rows.length, JSON.stringify(summary.totalsByUnit), summary.zeroCount, summary.negativeCount, scope.key, scope.label, scope.count, warehouse.code, warehouse.name, warehouse.hash).run();
  for (let start = 0; start < rows.length; start += 500) {
    const payload = JSON.stringify(rows.slice(start, start + 500).map(r => [r.goodsNo, r.goodsName, r.unitName, r.quantity, r.skuCount, compareQuantity(r.quantity, "0")]));
    if (new TextEncoder().encode(payload).length > 1_000_000) throw new Error("单批货品字段过长，本次未发布");
    await db.prepare("INSERT INTO stock_entries (snapshot_id, goods_no, goods_name, unit_name, quantity, sku_count, sign) SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]') FROM json_each(?)").bind(id, payload).run();
  }
  const result = await db.batch([
    db.prepare("UPDATE sync_runs SET status = 'complete', completed_at = ?, page_count = ?, record_count = ?, goods_count = ?, message = ? WHERE id = ? AND owner = ? AND warehouse_code = ? AND status = 'running'").bind(captured, pageCount, recordCount, rows.length, `自动核对 ${scope.count} 个条码，${rows.length} 个货品；${duplicateCount ? `去重 ${duplicateCount} 条；` : ""}全量分页完成`, id, owner, warehouse.code),
    db.prepare("UPDATE stock_snapshots SET status = 'complete' WHERE id = ? AND EXISTS (SELECT 1 FROM sync_runs WHERE id = ? AND status = 'complete' AND completed_at = ?)").bind(id, id, captured),
    db.prepare("UPDATE warehouses SET name = ?, warehouse_id = ? WHERE owner = ? AND code = ? AND EXISTS (SELECT 1 FROM stock_snapshots WHERE id = ? AND status = 'complete')").bind(warehouse.name, warehouse.id, owner, warehouse.code, id),
    // Immutable first successful capture after 08:00; later manual refreshes update current inventory only.
    db.prepare("INSERT OR IGNORE INTO daily_slots (owner, warehouse_code, date, snapshot_id) SELECT ?, ?, ?, ? WHERE ? >= '08:00:00' AND EXISTS (SELECT 1 FROM stock_snapshots WHERE id = ? AND status = 'complete')").bind(owner, warehouse.code, date, id, localTime.slice(11), id),
  ]);
  if (!result[0].meta.changes) throw new Error("采集已失效，未发布本次数据");
  return captured;
}
export async function failRun(id: string, message: string) {
  await database().prepare("UPDATE sync_runs SET status = 'failed', completed_at = ?, message = ? WHERE id = ? AND status = 'running'").bind(new Date().toISOString(), message.slice(0,300), id).run();
}
export async function loadRuns(owner: string, code = WAREHOUSE_CODE): Promise<RunInfo[]> {
  const result = await database().prepare("SELECT id, status, started_at AS startedAt, completed_at AS completedAt, page_count AS pageCount, record_count AS recordCount, goods_count AS goodsCount, message, warehouse_code AS warehouseCode FROM sync_runs WHERE owner = ? AND warehouse_code = ? ORDER BY started_at DESC LIMIT 20").bind(owner, code).all<RunInfo>();
  return result.results;
}
export async function allRows(owner: string, code = WAREHOUSE_CODE) {
  const view = await loadInventory(owner, { warehouseCode: code });
  if (!view.snapshot) throw new Error("该仓库暂无完整采集，请先采集库存");
  const result = await database().prepare("SELECT * FROM stock_entries WHERE snapshot_id = ? ORDER BY goods_no").bind(view.snapshot.id).all<EntryRecord>();
  return { view, rows: result.results.map(mapEntry) };
}
