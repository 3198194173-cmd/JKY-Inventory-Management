import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

test('imports a historical daily baseline without overwriting the current day and can be repeated', () => {
  const dir = mkdtempSync(join(process.cwd(), '.sites-runtime', 'jky-legacy-'));
  try {
    const dbPath = join(dir, 'inventory.sqlite');
    const env = { ...process.env, INVENTORY_DB_PATH: dbPath, INVENTORY_OWNER_ID: 'admin' };
    const bootstrap = spawnSync(process.execPath, ['--input-type=module', '-e', `import { sqlite } from './lib/sqlite.mjs'; const db=sqlite(); db.prepare("INSERT INTO warehouses (owner,code,name,created_at) VALUES ('admin','CK031','仓库','2026-09-30T00:00:00Z')").run(); db.prepare("INSERT INTO stock_snapshots (id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,warehouse_name,coverage) VALUES ('today','admin','2026-09-30','2026-09-30T06:00:00Z','complete',1,1,1,?,0,0,'CK031','仓库','auto:v1')").run(JSON.stringify({Pcs:'3'})); db.prepare("INSERT INTO daily_slots (owner,warehouse_code,date,snapshot_id) VALUES ('admin','CK031','2026-09-30','today')").run();`], { cwd: process.cwd(), env, encoding: 'utf8' });
    assert.equal(bootstrap.status, 0, bootstrap.stderr);
    const bundlePath = join(dir, 'legacy.bundle.json');
    const snapshot = { id: 'yesterday', date: '2026-09-29', captured_at: '2026-09-29T00:03:00Z', status: 'complete', page_count: 1, record_count: 1, goods_count: 1, totals: '{"Pcs":"8"}', zero_count: 0, negative_count: 0, scope_key: '', scope_label: '', scope_count: 1, warehouse_code: 'CK031', warehouse_name: '仓库', coverage: 'auto:v1', catalog_hash: '', unavailable_skus: '[]' };
    writeFileSync(bundlePath, JSON.stringify({ manifest: { snapshot, expectedEntries: 1, filePrefix: 'test-legacy' }, rows: [{ snapshot_id: 'yesterday', goods_no: 'ABC', goods_name: '商品', unit_name: 'Pcs', quantity: '8', sku_count: 1, sign: 1 }] }));
    const run = () => spawnSync(process.execPath, ['scripts/import-legacy-snapshot.mjs', bundlePath], { cwd: process.cwd(), env, encoding: 'utf8' });
    let result = run(); assert.equal(result.status, 0, result.stderr);
    result = run(); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /已存在/);
    const db = new DatabaseSync(dbPath);
    assert.deepEqual(db.prepare('SELECT date,snapshot_id FROM daily_slots ORDER BY date').all().map(row => ({ ...row })), [{ date: '2026-09-29', snapshot_id: 'yesterday' }, { date: '2026-09-30', snapshot_id: 'today' }]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM stock_entries WHERE snapshot_id='yesterday'").get().n, 1);
    db.close();
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (error) { if (process.platform !== 'win32' || error.code !== 'EPERM') throw error; }
  }
});

test('validates the complete private CK031 export when available', { skip: !existsSync('.sites-runtime/legacy-ck031-2026-09-29.bundle.json') }, () => {
  const dir = mkdtempSync(join(process.cwd(), '.sites-runtime', 'jky-real-import-'));
  try {
    const dbPath = join(dir, 'inventory.sqlite');
    const env = { ...process.env, INVENTORY_DB_PATH: dbPath, INVENTORY_OWNER_ID: 'admin' };
    const bootstrap = spawnSync(process.execPath, ['--input-type=module', '-e', `import { sqlite } from './lib/sqlite.mjs'; sqlite().prepare("INSERT INTO warehouses (owner,code,name,created_at) VALUES ('admin','CK031','仓库','2026-09-30T00:00:00Z')").run();`], { cwd: process.cwd(), env, encoding: 'utf8' });
    assert.equal(bootstrap.status, 0, bootstrap.stderr);
    const result = spawnSync(process.execPath, ['scripts/import-legacy-snapshot.mjs', '.sites-runtime/legacy-ck031-2026-09-29.bundle.json'], { cwd: process.cwd(), env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const db = new DatabaseSync(dbPath);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_entries').get().n, 6137);
    assert.equal(db.prepare("SELECT goods_count FROM stock_snapshots WHERE date='2026-09-29'").get().goods_count, 6137);
    db.close();
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (error) { if (process.platform !== 'win32' || error.code !== 'EPERM') throw error; }
  }
});
