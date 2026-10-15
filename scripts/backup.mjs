import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, openSync, closeSync, writeFileSync, rmSync, renameSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';

const source = process.env.INVENTORY_DB_PATH || '/app/storage/inventory.sqlite';
const dir = join(dirname(source), 'backups');
mkdirSync(dir, { recursive: true });
const lock = join(dir, '.inventory-backup.lock');
let lockFd;
try { lockFd = openSync(lock, 'wx'); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.error(`已有备份任务或上次异常退出留下的锁：${lock}。请先确认备份进程已结束，再移除该锁；不要重复启动。`);
  process.exit(1);
}
writeFileSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
const target = join(dir, `inventory-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
const partial = `${target}.partial`;
let db, complete = false;
const cleanup = () => {
  if (!complete) for (const path of [partial, `${partial}-journal`]) {
    try { rmSync(path, { force: true }); } catch { /* A failed backup retains a .partial suffix. */ }
  }
  closeSync(lockFd);
  rmSync(lock, { force: true });
};
process.once('exit', cleanup);
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));
const timer = setTimeout(() => {
  console.error('备份超过 10 分钟，已停止。请检查磁盘空间及磁盘负载，未完成文件不能用于恢复。');
  process.exit(1);
}, 10 * 60 * 1000);
try {
  db = new DatabaseSync(source, { readOnly: true });
  // Pin a WAL read snapshot, so worker heartbeat writes cannot restart the backup.
  db.exec('BEGIN');
  db.prepare('SELECT count(*) FROM sqlite_schema').get();
  const pages = Number(db.prepare('PRAGMA page_count').get().page_count);
  const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
  const disk = statfsSync(dir);
  const free = disk.bavail * disk.bsize;
  const required = pages * pageSize + 128 * 1024 * 1024;
  if (free < required) throw new Error(`备份空间不足：需要至少 ${(required / 1024 ** 3).toFixed(2)} GB，可用 ${(free / 1024 ** 3).toFixed(2)} GB。请释放空间后重试。`);
  console.log(`开始备份固定快照：${(pages * pageSize / 1024 ** 2).toFixed(0)} MB；完成前文件名为 .partial。`);
  let lastLog = 0;
  await backup(db, partial, {
    rate: 2048,
    progress: ({ remainingPages, totalPages }) => {
      if (Date.now() - lastLog < 5000 && remainingPages !== 0) return;
      lastLog = Date.now();
      console.log(`备份进度 ${totalPages ? Math.floor((totalPages - remainingPages) / totalPages * 100) : 100}%（${totalPages - remainingPages}/${totalPages} 页）`);
    },
  });
  db.exec('ROLLBACK');
  db.close(); db = undefined;
  // Let the asynchronous backup worker release its destination handle on Windows.
  await nextTurn();
  renameSync(partial, target);
  complete = true;
  console.log(`备份完成：${target}`);
} catch (error) {
  console.error(`备份失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  db?.close();
}
