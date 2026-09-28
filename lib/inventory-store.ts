import { env } from "cloudflare:workers";
import { compareQuantity } from "./decimal";
import { shanghaiTimestamp, WAREHOUSE_CODE, WAREHOUSE_NAME } from "./jackyun";
import { sampleView, summarizeRows } from "./sample";
import { serverConfig } from "./server-config";
import type { InventoryView, RunInfo, SnapshotInfo, StockRow } from "./inventory-types";
import type { ScopeInfo } from "./stock-scope";

export function database(): D1Database {
  if (!env.DB) throw new Error("库存数据存储尚未配置");
  return env.DB;
}

type SnapshotRecord = { id: string; date: string; captured_at: string; page_count: number; record_count: number; goods_count: number; totals: string; zero_count: number; negative_count: number; scope_key: string; scope_label: string; scope_count: number };
type EntryRecord = { goods_no: string; goods_name: string; unit_name: string; quantity: string; sku_count: number; date?: string };
const mapSnapshot = (s: SnapshotRecord): SnapshotInfo => ({ id: s.id, date: s.date, capturedAt: s.captured_at, pageCount: s.page_count, recordCount: s.record_count, source: "live", scope: { key: s.scope_key, label: s.scope_label, count: s.scope_count } });
const mapEntry = (r: EntryRecord): StockRow => ({ goodsNo: r.goods_no, goodsName: r.goods_name, unitName: r.unit_name, quantity: r.quantity, skuCount: r.sku_count });

export async function loadInventory(owner: string, query: { source?: string; q?: string; filter?: string; days?: number; page?: number; sort?: string } = {}): Promise<InventoryView> {
  const config = serverConfig();
  const latest = await database().prepare("SELECT * FROM stock_snapshots WHERE owner = ? AND status = 'complete' ORDER BY captured_at DESC, id DESC LIMIT 1").bind(owner).first<SnapshotRecord>();
  if (query.source === "sample" || !latest) {
    const view = sampleView(config.configured, config.robotConfigured);
    let rows = view.rows.filter(row => !query.q || (row.goodsNo + row.goodsName).toLowerCase().includes(query.q.toLowerCase()));
    rows = rows.filter(row => query.filter === "zero" ? compareQuantity(row.quantity, "0") === 0 : query.filter === "negative" ? compareQuantity(row.quantity, "0") < 0 : query.filter === "positive" ? compareQuantity(row.quantity, "0") > 0 : true);
    if (query.sort === "quantity") rows.sort((a,b) => compareQuantity(b.quantity, a.quantity));
    return { ...view, rows, totalRows: rows.length };
  }
  const days = query.days || 14, page = query.page || 1, pageSize = 50;
  const records = await database().prepare("SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY date ORDER BY captured_at DESC, id DESC) AS daily_rank FROM stock_snapshots WHERE owner = ? AND scope_key = ? AND status = 'complete') WHERE daily_rank = 1 ORDER BY captured_at DESC LIMIT 30").bind(owner, latest.scope_key).all<SnapshotRecord>();
  const uniqueDays = new Map<string, SnapshotRecord>();
  for (const record of records.results) if (!uniqueDays.has(record.date)) uniqueDays.set(record.date, record);
  const lower = new Date(latest.date + "T00:00:00Z");
  lower.setUTCDate(lower.getUTCDate() - days + 1);
  const daily = Array.from(uniqueDays.values()).filter(r => r.date >= lower.toISOString().slice(0,10) && r.scope_key === latest.scope_key);
  const parameters: (string | number)[] = [latest.id];
  let where = "snapshot_id = ?";
  if (query.q) { where += " AND (instr(lower(goods_no), ?) > 0 OR instr(lower(goods_name), ?) > 0)"; parameters.push(query.q.toLowerCase(), query.q.toLowerCase()); }
  if (query.filter === "zero") where += " AND sign = 0";
  if (query.filter === "negative") where += " AND sign < 0";
  if (query.filter === "positive") where += " AND sign > 0";
  const count = await database().prepare(`SELECT COUNT(*) AS count FROM stock_entries WHERE ${where}`).bind(...parameters).first<{ count: number }>();
  // Normalized decimal text sorts exactly, including values beyond REAL precision.
  const sort = query.sort === "quantity" ? "sign DESC, CASE WHEN sign > 0 THEN instr(quantity || '.', '.') - 1 WHEN sign < 0 THEN 2 - instr(quantity || '.', '.') ELSE 0 END DESC, CASE WHEN sign > 0 THEN quantity END COLLATE BINARY DESC, CASE WHEN sign < 0 THEN substr(quantity, 2) END COLLATE BINARY ASC, goods_no COLLATE BINARY ASC" : "goods_no";
  const result = await database().prepare(`SELECT * FROM stock_entries WHERE ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`).bind(...parameters, pageSize, (page - 1) * pageSize).all<EntryRecord>();
  const goods = result.results.map(r => r.goods_no);
  const history = new Map<string, Record<string,string>>();
  if (goods.length) {
    const values = await database().prepare(`SELECT e.goods_no, e.quantity, s.date FROM stock_entries e JOIN stock_snapshots s ON s.id = e.snapshot_id WHERE s.owner = ? AND e.snapshot_id IN (${daily.map(() => "?").join(",")}) AND e.goods_no IN (${goods.map(() => "?").join(",")})`).bind(owner, ...daily.map(s => s.id), ...goods).all<EntryRecord>();
    for (const r of values.results) { const entry = history.get(r.goods_no) || {}; entry[r.date!] = r.quantity; history.set(r.goods_no, entry); }
  }
  return { warehouseCode: WAREHOUSE_CODE, warehouseName: WAREHOUSE_NAME, source: "live", snapshot: mapSnapshot(latest), snapshots: daily.map(mapSnapshot), rows: result.results.map(r => ({ ...mapEntry(r), history: history.get(r.goods_no) || {} })), configured: config.configured, robotConfigured: config.robotConfigured, totalRows: count?.count || 0, goodsCount: latest.goods_count, page, pageSize, totalsByUnit: JSON.parse(latest.totals), zeroCount: latest.zero_count, negativeCount: latest.negative_count };
}

export async function acquireRun(owner: string): Promise<string> {
  const db = database(), now = new Date().toISOString();
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  await db.prepare("UPDATE sync_runs SET status = 'failed', completed_at = ?, message = '采集超过十分钟，已解除锁定；请重试' WHERE owner = ? AND status = 'running' AND started_at < ?").bind(now, owner, cutoff).run();
  const id = crypto.randomUUID();
  const result = await db.prepare("INSERT INTO sync_runs (id, owner, status, started_at) SELECT ?, ?, 'running', ? WHERE NOT EXISTS (SELECT 1 FROM sync_runs WHERE owner = ? AND status = 'running')").bind(id, owner, now, owner).run();
  if (!result.meta.changes) throw new Error("已有库存采集正在进行，请等待完成");
  return id;
}

export async function updateRun(id: string, pages: number, records: number, goods: number) {
  await database().prepare("UPDATE sync_runs SET page_count = ?, record_count = ?, goods_count = ? WHERE id = ? AND status = 'running'").bind(pages, records, goods, id).run();
}

export async function publishSnapshot(owner: string, id: string, rows: StockRow[], pageCount: number, recordCount: number, duplicateCount: number, scope: ScopeInfo) {
  const db = database(), captured = new Date().toISOString(), date = shanghaiTimestamp().slice(0,10), summary = summarizeRows(rows);
  await db.prepare("INSERT INTO stock_snapshots (id, owner, date, captured_at, status, page_count, record_count, goods_count, totals, zero_count, negative_count, scope_key, scope_label, scope_count) VALUES (?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, owner, date, captured, pageCount, recordCount, rows.length, JSON.stringify(summary.totalsByUnit), summary.zeroCount, summary.negativeCount, scope.key, scope.label, scope.count).run();
  // JSON string quantities keep precision and use two bind parameters per
  // 500-row insert, rather than hundreds of per-row D1 queries.
  for (let start = 0; start < rows.length; start += 500) {
    const payload = JSON.stringify(rows.slice(start, start + 500).map(r => [r.goodsNo, r.goodsName, r.unitName, r.quantity, r.skuCount, compareQuantity(r.quantity, "0")]));
    if (new TextEncoder().encode(payload).length > 1_000_000) throw new Error("单批货品字段过长，本次未发布");
    await db.prepare("INSERT INTO stock_entries (snapshot_id, goods_no, goods_name, unit_name, quantity, sku_count, sign) SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]') FROM json_each(?)").bind(id, payload).run();
  }
  const result = await db.batch([
    db.prepare("UPDATE sync_runs SET status = 'complete', completed_at = ?, page_count = ?, record_count = ?, goods_count = ?, message = ? WHERE id = ? AND owner = ? AND status = 'running'").bind(captured, pageCount, recordCount, rows.length, `${scope.label}：${scope.count} 个条码已核对，分页完成${duplicateCount ? `，去重 ${duplicateCount} 条相同记录` : ""}`, id,owner),
    db.prepare("UPDATE stock_snapshots SET status = 'complete' WHERE id = ? AND EXISTS (SELECT 1 FROM sync_runs WHERE id = ? AND status = 'complete' AND completed_at = ?)").bind(id,id,captured),
  ]);
  if(!result[0].meta.changes) throw new Error("采集已失效，未发布本次数据");
  return captured;
}

export async function failRun(id: string, message: string) {
  await database().prepare("UPDATE sync_runs SET status = 'failed', completed_at = ?, message = ? WHERE id = ? AND status = 'running'").bind(new Date().toISOString(), message.slice(0,300), id).run();
}

export async function loadRuns(owner: string): Promise<RunInfo[]> {
  const result = await database().prepare("SELECT id, status, started_at AS startedAt, completed_at AS completedAt, page_count AS pageCount, record_count AS recordCount, goods_count AS goodsCount, message FROM sync_runs WHERE owner = ? ORDER BY started_at DESC LIMIT 20").bind(owner).all<RunInfo>();
  return result.results;
}

export async function allRows(owner: string, source?: string) {
  const view = await loadInventory(owner, { source });
  if (view.source === "sample") return { view, rows: view.rows as StockRow[] };
  const result = await database().prepare("SELECT * FROM stock_entries WHERE snapshot_id = ? ORDER BY goods_no").bind(view.snapshot!.id).all<EntryRecord>();
  return { view, rows: result.results.map(mapEntry) };
}
