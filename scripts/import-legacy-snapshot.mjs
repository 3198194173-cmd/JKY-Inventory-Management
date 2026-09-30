import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sqlite } from '../lib/sqlite.mjs';

const sourceFile = process.argv[2];
if (!sourceFile) throw new Error('用法: node scripts/import-legacy-snapshot.mjs <私有快照文件>');
const bundle = JSON.parse(readFileSync(resolve(sourceFile), 'utf8'));
const { manifest, rows } = bundle;
if (!manifest || !Array.isArray(rows)) throw new Error('历史快照文件结构无效');
const { snapshot, expectedEntries, filePrefix } = manifest;
if (!snapshot || snapshot.status !== 'complete' || snapshot.coverage !== 'auto:v1') throw new Error('仅支持完整的自动采集快照');
if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.date) || !/^[A-Za-z0-9_.-]{1,50}$/.test(snapshot.warehouse_code)) throw new Error('快照日期或仓库编码无效');
if (!Number.isSafeInteger(expectedEntries) || expectedEntries < 1 || snapshot.goods_count !== expectedEntries) throw new Error('快照货品数与清单预期不符');
if (typeof filePrefix !== 'string' || !/^[a-z0-9-]+$/.test(filePrefix)) throw new Error('导入文件前缀无效');
if (rows.length !== expectedEntries) throw new Error(`清单不完整：预期 ${expectedEntries}，实际 ${rows.length}`);
const seen = new Set();
for (const row of rows) {
  if (row.snapshot_id !== snapshot.id || typeof row.goods_no !== 'string' || !row.goods_no || typeof row.goods_name !== 'string' || typeof row.unit_name !== 'string' || typeof row.quantity !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(row.quantity) || !Number.isSafeInteger(row.sku_count) || ![-1, 0, 1].includes(row.sign)) throw new Error('历史清单包含无效货品行');
  if (seen.has(row.goods_no)) throw new Error(`重复货品编码：${row.goods_no}`);
  seen.add(row.goods_no);
  const sign = row.quantity.startsWith('-') && Number(row.quantity) !== 0 ? -1 : Number(row.quantity) === 0 ? 0 : 1;
  if (sign !== row.sign) throw new Error(`库存正负标记不一致：${row.goods_no}`);
}
const owner = process.env.INVENTORY_OWNER_ID || 'admin';
const db = sqlite();
const slot = db.prepare('SELECT snapshot_id FROM daily_slots WHERE owner=? AND warehouse_code=? AND date=?').get(owner, snapshot.warehouse_code, snapshot.date);
if (slot && slot.snapshot_id !== snapshot.id) throw new Error('当天已有不同的采集基准，拒绝覆盖');
const existing = db.prepare('SELECT owner, warehouse_code, date, status FROM stock_snapshots WHERE id=?').get(snapshot.id);
if (existing) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM stock_entries WHERE snapshot_id=?').get(snapshot.id).n;
  if (existing.owner === owner && existing.warehouse_code === snapshot.warehouse_code && existing.date === snapshot.date && existing.status === 'complete' && count === expectedEntries && slot?.snapshot_id === snapshot.id) {
    console.log(`历史基准已存在，跳过：${snapshot.warehouse_code} ${snapshot.date}，${count} 条`);
    process.exit(0);
  }
  throw new Error('快照 ID 已存在但内容或每日基准不一致，拒绝覆盖');
}
const warehouse = db.prepare('SELECT 1 FROM warehouses WHERE owner=? AND code=?').get(owner, snapshot.warehouse_code);
if (!warehouse) throw new Error(`目标账号还没有仓库 ${snapshot.warehouse_code}，请先在网页添加`);
db.exec('BEGIN IMMEDIATE');
try {
  db.prepare(`INSERT INTO stock_snapshots (id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,scope_key,scope_label,scope_count,warehouse_code,warehouse_name,coverage,catalog_hash,unavailable_skus) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(snapshot.id, owner, snapshot.date, snapshot.captured_at, 'complete', snapshot.page_count, snapshot.record_count, snapshot.goods_count, snapshot.totals, snapshot.zero_count, snapshot.negative_count, snapshot.scope_key, snapshot.scope_label, snapshot.scope_count, snapshot.warehouse_code, snapshot.warehouse_name, snapshot.coverage, snapshot.catalog_hash, snapshot.unavailable_skus);
  const insert = db.prepare('INSERT INTO stock_entries (snapshot_id,goods_no,goods_name,unit_name,quantity,sku_count,sign) VALUES (?,?,?,?,?,?,?)');
  for (const row of rows) insert.run(snapshot.id, row.goods_no, row.goods_name, row.unit_name, row.quantity, row.sku_count, row.sign);
  db.prepare('INSERT INTO daily_slots (owner,warehouse_code,date,snapshot_id) VALUES (?,?,?,?)').run(owner, snapshot.warehouse_code, snapshot.date, snapshot.id);
  db.exec('COMMIT');
} catch (error) { db.exec('ROLLBACK'); throw error; }
console.log(`历史基准导入成功：${snapshot.warehouse_code} ${snapshot.date}，${rows.length} 条；现有当天快照未修改`);
