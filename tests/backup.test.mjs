import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

function run(source, onOutput = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/backup.mjs'], {
      env: { ...process.env, INVENTORY_DB_PATH: source }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; onOutput(String(chunk)); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}

test('backup preserves a consistent snapshot during concurrent writes and publishes only a complete file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inventory-backup-test-'));
  const source = join(dir, 'inventory.sqlite');
  const db = new DatabaseSync(source);
  let writes = 0;
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE records(id INTEGER PRIMARY KEY, value INTEGER, payload BLOB);');
    db.exec('BEGIN');
    for (let i = 0; i < 32; i++) db.prepare('INSERT INTO records(value,payload) VALUES(1,zeroblob(1048576))').run();
    db.exec('COMMIT');
    const result = await run(source, output => {
      if (output.includes('开始备份') || output.includes('备份进度')) {
        db.exec('UPDATE records SET value=value+1'); writes++;
      }
    });
    assert.equal(result.code, 0, result.output);
    assert.ok(writes > 0);
    assert.match(result.output, /备份完成/);
    const files = readdirSync(join(dir, 'backups'));
    assert.equal(files.length, 1);
    assert.match(files[0], /\.sqlite$/);
    const copy = new DatabaseSync(join(dir, 'backups', files[0]), { readOnly: true });
    try {
      assert.equal(copy.prepare('PRAGMA quick_check').get().quick_check, 'ok');
      assert.equal(copy.prepare('SELECT count(*) AS n FROM records WHERE value=1').get().n, 32);
    } finally { copy.close(); }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('backup refuses a concurrent task and does not create a missing source database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inventory-backup-test-'));
  try {
    const source = join(dir, 'missing.sqlite');
    const result = await run(source);
    assert.equal(result.code, 1);
    assert.deepEqual(readdirSync(dir), ['backups']);
    const backupDir = join(dir, 'backups');
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, '.inventory-backup.lock'), 'another task');
    const locked = await run(source);
    assert.equal(locked.code, 1);
    assert.match(locked.output, /已有备份任务/);
    assert.deepEqual(readdirSync(backupDir), ['.inventory-backup.lock']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
