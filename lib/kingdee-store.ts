import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import preset from '@/data/kingdee-default-rules.json';
import { AccessError } from './accounts';
import { sourceKinds, type KingdeeBatch, type KingdeeGoods, type KingdeeReport, type KingdeeRules, type SourceKind, type SourceReferences, type WarehouseMember } from './kingdee-types';
import type { ImportFile } from './kingdee-import';
import { defaultKingdeeTemplate, sheetDataPath } from './kingdee-sheet';
import type { XingkongProbe } from './kingdee-xingkong-types';

let connection: DatabaseSync | undefined;
let busy = false;
function paths() {
  const base = dirname(resolve(process.env.INVENTORY_DB_PATH || 'storage/inventory.sqlite'));
  const database = resolve(process.env.KINGDEE_DB_PATH || join(base, 'kingdee.sqlite'));
  if (database === resolve(process.env.INVENTORY_DB_PATH || 'storage/inventory.sqlite')) throw new Error('金蝶业务库必须与原库存库分开');
  return { database, files: resolve(process.env.KINGDEE_STORAGE_DIR || join(base, 'kingdee-files')) };
}
function db() {
  if (connection) return connection;
  const path = paths().database; mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;
    CREATE TABLE IF NOT EXISTS kd_settings(owner TEXT PRIMARY KEY, rules TEXT NOT NULL, updated_at TEXT NOT NULL, actor_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS kd_batches(id TEXT PRIMARY KEY, owner TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
      state TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '{}', sources TEXT NOT NULL DEFAULT '[]', rules TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS kd_batch_owner ON kd_batches(owner,created_at DESC);
    CREATE TABLE IF NOT EXISTS kd_goods(batch_id TEXT NOT NULL REFERENCES kd_batches(id), code TEXT NOT NULL, name TEXT NOT NULL,
      category TEXT, model TEXT, pod TEXT, ip TEXT, price_status TEXT NOT NULL, unclassified INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(batch_id,code));`);
  database.exec(`CREATE TABLE IF NOT EXISTS kd_probes(id TEXT PRIMARY KEY,owner TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS kd_probe_owner ON kd_probes(owner,created_at DESC);`);
  connection = database;
  if (!database.prepare('PRAGMA table_info(kd_batches)').all().some(column => column.name === 'template')) database.exec("ALTER TABLE kd_batches ADD COLUMN template TEXT NOT NULL DEFAULT 'null'");
  return database;
}
export function kingdeeRules(owner: string): KingdeeRules {
  const row = db().prepare('SELECT rules FROM kd_settings WHERE owner=?').get(owner);
  return row ? JSON.parse(String(row.rules)) : structuredClone(preset) as KingdeeRules;
}
export function saveKingdeeWarehouses(owner: string, actorId: string, value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 300) throw new AccessError('请填写1至300个仓库', 400);
  const seen = new Set<string>();
  const members: WarehouseMember[] = value.map(item => {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    if (!name || name.length > 150 || !['inner', 'outer', 'excluded'].includes(item.group) || seen.has(name)) throw new AccessError('仓库名称或归属无效，同名仓库不能重复', 400);
    seen.add(name); return { name, group: item.group };
  });
  const rules = kingdeeRules(owner);
  rules.warehouses = { members, scopeMode: 'selected_warehouses', membershipConfirmed: true };
  rules.version++; rules.confirmedOn = new Date().toISOString().slice(0, 10);
  db().prepare('INSERT INTO kd_settings VALUES(?,?,?,?) ON CONFLICT(owner) DO UPDATE SET rules=excluded.rules,updated_at=excluded.updated_at,actor_id=excluded.actor_id').run(owner, JSON.stringify(rules), new Date().toISOString(), actorId);
  return rules;
}
function parseBatch(row: Record<string, unknown>): KingdeeBatch {
  return { id: String(row.id), createdAt: String(row.created_at), state: String(row.state), error: String(row.error),
    summary: JSON.parse(String(row.summary)), sources: JSON.parse(String(row.sources)), rules: JSON.parse(String(row.rules)), template: JSON.parse(String(row.template || 'null')) || undefined };
}
export function getKingdeeBatch(owner: string, id: string) {
  const row = db().prepare('SELECT * FROM kd_batches WHERE id=? AND owner=?').get(id, owner);
  if (!row) throw new AccessError('找不到该账户的导入批次', 404);
  return parseBatch(row);
}
function batchDirectory(owner: string, id: string) {
  if (!/^[\da-f-]{36}$/i.test(id)) throw new AccessError('批次编号无效', 400);
  return join(paths().files, createHash('sha256').update(owner).digest('hex'), id);
}
export type KingdeeUpload = { kind: SourceKind; name: string; bytes: Buffer };

// Samples have a separate table and never become ready import batches or source references.
export function saveXingkongProbe(owner: string, actorId: string, probe: XingkongProbe) {
  db().prepare('INSERT INTO kd_probes VALUES(?,?,?,?,?,?)').run(probe.id, owner, actorId, probe.createdAt, probe.kind, JSON.stringify(probe));
}
export function listXingkongProbes(owner: string) {
  return db().prepare('SELECT id,created_at,kind,data FROM kd_probes WHERE owner=? ORDER BY created_at DESC LIMIT 10').all(owner).map(row => {
    const probe = JSON.parse(String(row.data)) as XingkongProbe;
    return { id: probe.id, createdAt: probe.createdAt, kind: probe.kind, returnedRows: probe.returnedRows, total: probe.total };
  });
}
export function getXingkongProbe(owner: string, id: string): XingkongProbe {
  if (!/^[\da-f-]{36}$/i.test(id)) throw new AccessError('探测记录编号无效', 400);
  const row = db().prepare('SELECT data FROM kd_probes WHERE id=? AND owner=?').get(id, owner);
  if (!row) throw new AccessError('找不到当前账户的探测记录', 404);
  return JSON.parse(String(row.data)) as XingkongProbe;
}

export async function createKingdeeImport(owner: string, actorId: string, uploads: KingdeeUpload[], previousId?: string, references: SourceReferences = {}) {
  if (busy) throw new AccessError('正在处理另一批金蝶文件，请稍后重试', 409);
  const previous = previousId ? getKingdeeBatch(owner, previousId) : null;
  if (previous && previous.state !== 'ready') throw new AccessError('该批次尚不能重算', 400);
  const saved = new Map<SourceKind, { batch: KingdeeBatch; source: KingdeeBatch['sources'][number] }>();
  if (Object.keys(references).some(key => !sourceKinds.includes(key as SourceKind))) throw new AccessError('来源类型无效', 400);
  for (const kind of sourceKinds) {
    const reference = references[kind] || previous?.id;
    if (uploads.some(file => file.kind === kind)) { if (references[kind]) throw new AccessError('同一种来源不能同时上传和复用', 400); continue; }
    if (!reference) continue;
    const batch = previous?.id === reference ? previous : getKingdeeBatch(owner, reference);
    if (batch.state !== 'ready') throw new AccessError('只能选择已成功生成的来源版本', 400);
    const source = batch.sources.find(item => item.kind === kind);
    if (!source) { if (references[kind]) throw new AccessError('所选批次不包含该来源', 400); continue; }
    saved.set(kind, { batch, source });
  }
  if (sourceKinds.slice(0, 5).some(kind => !uploads.some(file => file.kind === kind) && !saved.has(kind))) throw new AccessError('请准备四份业务表和销售价目表，或明确选择已保存版本', 400);
  const bytes = uploads.reduce((sum, file) => sum + file.bytes.length, 0) + [...saved.values()].reduce((sum, item) => sum + item.source.size, 0);
  if (bytes > 50 * 1024 * 1024) throw new AccessError('本批上传与复用文件合计不能超过50MB', 413);
  const id = randomUUID(), rules = kingdeeRules(owner), directory = batchDirectory(owner, id);
  const database = db();
  database.prepare('INSERT INTO kd_batches(id,owner,actor_id,created_at,state,rules) VALUES(?,?,?,?,?,?)').run(id, owner, actorId, new Date().toISOString(), 'processing', JSON.stringify(rules));
  busy = true;
  try {
    await mkdir(directory, { recursive: true });
    const files: ImportFile[] = [];
    for (const kind of sourceKinds) {
      const upload = uploads.find(file => file.kind === kind);
      const old = saved.get(kind);
      if (!upload && !old) continue;
      const path = join(directory, kind + '.xlsx');
      if (upload) await writeFile(path, upload.bytes, { flag: 'wx' });
      else await copyFile(join(batchDirectory(owner, old!.batch.id), kind + '.xlsx'), path);
      files.push({ kind, path, name: upload?.name || old!.source.name });
    }
    const output = join(directory, 'report.json');
    await new Promise<void>((accept, reject) => {
      const worker = new Worker(resolve('build-node/kingdee-import.mjs'), { workerData: { files, output, rules }, resourceLimits: { maxOldGenerationSizeMb: 768 } });
      let settled = false;
      const timer = setTimeout(() => { settled = true; void worker.terminate(); reject(new Error('解析超过180秒，请检查源表规模后重试')); }, 180000);
      worker.once('message', message => { settled = true; clearTimeout(timer); if (message.ok) accept(); else reject(new Error(message.error || 'Excel解析失败')); });
      worker.once('error', () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Excel解析进程失败，请检查文件后重试')); } });
      worker.once('exit', code => { if (!settled) { clearTimeout(timer); reject(new Error('解析进程提前结束：' + code)); } });
    });
    const report = JSON.parse(await readFile(output, 'utf8')) as KingdeeReport;
    for (const source of report.sources) {
      const old = saved.get(source.kind);
      if (old) {
        if (source.sha256 !== old.source.sha256 || source.size !== old.source.size) throw new Error('已保存原件校验不一致，请重新上传：' + source.kind);
        source.originBatchId = old.batch.id;
      }
    }
    database.exec('BEGIN IMMEDIATE');
    try {
      const insert = database.prepare('INSERT INTO kd_goods VALUES(?,?,?,?,?,?,?,?,?,?)');
      for (const row of report.rows) insert.run(id, row.code, row.name, row.category, row.model, row.pod, row.ip, row.priceStatus,
        [row.category, row.model, row.pod, row.ip].some(value => value === null) ? 1 : 0, JSON.stringify(row));
      database.prepare("UPDATE kd_batches SET state='ready',summary=?,sources=?,template=? WHERE id=? AND owner=?").run(JSON.stringify(report.summary), JSON.stringify(report.sources), JSON.stringify(report.template || null), id, owner);
      database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }
    return getKingdeeBatch(owner, id);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : '导入失败';
    database.prepare("UPDATE kd_batches SET state='failed',error=? WHERE id=? AND owner=?").run(message, id, owner);
    throw new AccessError(message, 400);
  } finally { busy = false; }
}

export function kingdeeView(owner: string, params: URLSearchParams = new URLSearchParams()) {
  const database = db();
  const history = database.prepare('SELECT * FROM kd_batches WHERE owner=? ORDER BY created_at DESC LIMIT 15').all(owner).map(parseBatch);
  const readyRow = database.prepare("SELECT * FROM kd_batches WHERE owner=? AND state='ready' ORDER BY created_at DESC LIMIT 1").get(owner);
  const latestReady = readyRow ? parseBatch(readyRow) : null;
  if (latestReady && !history.some(item => item.id === latestReady.id)) history.push(latestReady);
  const requested = params.get('batch');
  const batch = requested ? getKingdeeBatch(owner, requested) : latestReady;
  const rules = kingdeeRules(owner);
  if (!batch || batch.state !== 'ready') return { batch: null, history, rules, rows: [] as KingdeeGoods[], totalRows: 0, page: 1, pageSize: 100, rulesChanged: false };
  const pageSize = 100;
  const values: (string | number)[] = [batch.id];
  let where = 'batch_id=?';
  const mode = params.get('sheet') === 'original' ? 'original' : 'current';
  if (mode === 'original') where += " AND json_type(data,'$.legacy')='object'";
  const q = (params.get('q') || '').trim().slice(0, 150);
  if (q) { where += " AND (code LIKE ? ESCAPE '!' OR name LIKE ? ESCAPE '!')"; const pattern = '%' + q.replace(/[!%_]/g, value => '!' + value) + '%'; values.push(pattern, pattern); }
  if (params.get('filter') === 'missing') where += " AND price_status='missing'";
  if (params.get('filter') === 'conflict') where += " AND price_status='conflict'";
  if (params.get('filter') === 'unclassified') where += ' AND unclassified=1';
  const columns = batch.template?.columns || defaultKingdeeTemplate.columns;
  const columnIndex = columns.findIndex(column => column.key === params.get('column'));
  const contains = (params.get('contains') || '').slice(0, 150);
  const expression = columnIndex < 0 ? null : mode === 'current' && columnIndex < 6
    ? `CASE WHEN json_type(data,'$.legacy')='object' THEN json_extract(data,'$.legacy.values[${columnIndex}]') ELSE json_extract(data,'${sheetDataPath(columnIndex, mode)}') END`
    : `json_extract(data,'${sheetDataPath(columnIndex, mode)}')`;
  if (contains && expression) { where += ` AND CAST(${expression} AS TEXT) LIKE ? ESCAPE '!'`; values.push('%' + contains.replace(/[!%_]/g, value => '!' + value) + '%'); }
  const count = Number(database.prepare('SELECT COUNT(*) AS n FROM kd_goods WHERE ' + where).get(...values)!.n);
  const page = Math.min(Math.max(1, Math.ceil(count / pageSize)), Math.max(1, Math.min(10000, Math.floor(Number(params.get('page')) || 1))));
  let order = "COALESCE(json_extract(data,'$.sheetRow'),2147483647),code";
  if (expression && ['asc', 'desc'].includes(params.get('direction') || '')) {
    const direction = params.get('direction') === 'desc' ? 'DESC' : 'ASC';
    order = `(${expression} IS NULL),${columnIndex >= 6 ? `CAST(${expression} AS REAL)` : expression} ${direction},code`;
  }
  const rows = database.prepare('SELECT data FROM kd_goods WHERE ' + where + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?').all(...values, pageSize, (page - 1) * pageSize).map(row => JSON.parse(String(row.data)) as KingdeeGoods);
  return { batch, history, rules, rows, totalRows: count, page, pageSize, rulesChanged: JSON.stringify(batch.rules) !== JSON.stringify(rules) };
}
export function kingdeeExportData(owner: string, id: string) {
  const batch = getKingdeeBatch(owner, id);
  if (batch.state !== 'ready') throw new AccessError('批次尚不能导出', 400);
  return { batch, rows: db().prepare("SELECT data FROM kd_goods WHERE batch_id=? ORDER BY COALESCE(json_extract(data,'$.sheetRow'),2147483647),code").all(batch.id).map(row => JSON.parse(String(row.data)) as KingdeeGoods) };
}

export async function readKingdeeSubmission(request: Request) {
  const limit = 50 * 1024 * 1024;
  if (Number(request.headers.get('content-length') || 0) > limit) throw new AccessError('本次文件合计不能超过50MB', 413);
  const type = request.headers.get('content-type') || '';
  if (!type.startsWith('multipart/form-data;')) throw new AccessError('请使用表格上传表单', 400);
  const reader = request.body?.getReader();
  if (!reader) throw new AccessError('没有收到上传内容', 400);
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length; if (size > limit) { await reader.cancel(); throw new AccessError('本次文件合计不能超过50MB', 413); } chunks.push(value);
  }
  const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': type } }).formData();
  const uploads: KingdeeUpload[] = [];
  let references: SourceReferences = {}, seenReferences = false;
  for (const [key, value] of form.entries()) {
    if (key === 'sourceReferences') {
      if (seenReferences || typeof value !== 'string' || value.length > 1000) throw new AccessError('来源版本参数无效', 400);
      seenReferences = true;
      let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new AccessError('来源版本参数不是有效JSON', 400); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.entries(parsed).some(([kind, id]) => !sourceKinds.includes(kind as SourceKind) || typeof id !== 'string' || !/^[\da-f-]{36}$/i.test(id))) throw new AccessError('来源版本参数无效', 400);
      references = parsed as SourceReferences; continue;
    }
    if (!sourceKinds.includes(key as SourceKind) || typeof value === 'string' || !value.size) throw new AccessError('上传来源类型无效', 400);
    if (uploads.some(file => file.kind === key) || !/\.xlsx$/i.test(value.name) || value.size > 32 * 1024 * 1024) throw new AccessError('每种来源只可上传一份xlsx，单份不超过32MB', 400);
    uploads.push({ kind: key as SourceKind, name: value.name.replace(/.*[\\/]/, '').slice(0, 200), bytes: Buffer.from(await value.arrayBuffer()) });
  }
  return { uploads, references };
}
