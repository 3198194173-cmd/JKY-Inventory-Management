import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

let connection;
export function sqlite() {
  if (connection) return connection;
  const path = resolve(process.env.INVENTORY_DB_PATH || 'storage/inventory.sqlite');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)');
  const dir = resolve('drizzle');
  for (const file of readdirSync(dir).filter(f => /^\d+.*\.sql$/.test(f)).sort()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!db.prepare('SELECT 1 FROM local_migrations WHERE name=?').get(file)) {
        db.exec(readFileSync(resolve(dir, file), 'utf8'));
        db.prepare('INSERT INTO local_migrations VALUES (?)').run(file);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS local_jobs (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, warehouse_code TEXT NOT NULL,
    trigger TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, message TEXT NOT NULL DEFAULT '等待后台采集', run_id TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS local_jobs_active ON local_jobs(owner,warehouse_code) WHERE state IN ('queued','running');
  CREATE TABLE IF NOT EXISTS local_worker (id INTEGER PRIMARY KEY CHECK(id=1), heartbeat TEXT NOT NULL, schedule_enabled INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS local_sessions (token_hash TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS local_login_attempts (username TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);`);
  connection = db;
  return db;
}

class Statement {
  constructor(sql, values = []) { this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.sql, values); }
  async first(column) { const row = sqlite().prepare(this.sql).get(...this.values); return column ? row?.[column] ?? null : row ?? null; }
  async all() { return { results: sqlite().prepare(this.sql).all(...this.values), success: true }; }
  execute() { const result = sqlite().prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) }, results: [] }; }
  async run() { return this.execute(); }
}
export const localDatabase = {
  prepare(sql) { return new Statement(sql); },
  async batch(statements) {
    const db = sqlite(); db.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(s => s.execute()); db.exec('COMMIT'); return results; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
};
