import { sqlite } from '../lib/sqlite.mjs';
import { enqueueDaily } from '../lib/local-jobs';
import { syncWarehouse } from '../lib/sync-warehouse';
import { acquireRun, failRun } from '../lib/inventory-store';
import { syncRobotGroups, GROUP_SYNC_INTERVAL } from '../lib/dingtalk-groups-store';
import { serverConfig } from '../lib/server-config';

type Job = {id:string;owner:string;warehouse_code:string;trigger:string;run_id:string|null};
const db = sqlite();
const scheduled = process.env.INVENTORY_SCHEDULE_ENABLED === 'true';
let active: Job | undefined, stopping = false;
const now = () => new Date().toISOString();
db.exec('BEGIN IMMEDIATE');
const prior = db.prepare('SELECT heartbeat FROM local_worker WHERE id=1').get();
if (prior && Date.now()-Date.parse(String(prior.heartbeat))<90000) {
  db.exec('ROLLBACK');
  throw new Error('已有后台进程心跳，拒绝同时启动第二个 worker；异常退出后最多等待90秒');
}
db.prepare('INSERT INTO local_worker VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET heartbeat=excluded.heartbeat,schedule_enabled=excluded.schedule_enabled').run(now(),scheduled?1:0);
db.exec('COMMIT');
function heartbeat() {
  db.prepare('INSERT INTO local_worker VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET heartbeat=excluded.heartbeat,schedule_enabled=excluded.schedule_enabled').run(now(),scheduled?1:0);
  if (active) {
    db.prepare('UPDATE local_jobs SET updated_at=? WHERE id=?').run(now(),active.id);
    if (active.run_id) db.prepare("UPDATE sync_runs SET last_progress_at=? WHERE id=? AND status='running'").run(now(),active.run_id);
  }
}
// A single worker is deployed. Interrupted tasks become explicit failures; retry starts a fresh snapshot.
for (const job of db.prepare("SELECT * FROM local_jobs WHERE state='running'").all() as Job[]) {
  if (job.run_id) await failRun(job.run_id,'后台进程重启，采集中断；请重新采集');
  db.prepare("UPDATE local_jobs SET state='failed',message='后台进程重启，采集中断',updated_at=? WHERE id=?").run(now(),job.id);
}
heartbeat();
const timer = setInterval(heartbeat,15000);
const groupAbort = new AbortController();
let groupSync: Promise<unknown> | undefined;
function syncGroups() {
  if (stopping || groupSync || !serverConfig().robotConfigured) return;
  groupSync = syncRobotGroups(process.env.INVENTORY_OWNER_ID || 'admin', { signal: groupAbort.signal })
    .catch(()=>console.error('钉钉群同步失败，请在网页预警设置中查看状态'))
    .finally(()=>{groupSync=undefined;});
}
syncGroups();
const groupTimer = setInterval(syncGroups,GROUP_SYNC_INTERVAL);
process.on('SIGTERM',()=>{stopping=true;});
process.on('SIGINT',()=>{stopping=true;});
try {
  while (!stopping) {
    if (scheduled && process.env.JACKYUN_APP_SECRET) enqueueDaily();
    active = db.prepare("UPDATE local_jobs SET state='running',updated_at=? WHERE id=(SELECT id FROM local_jobs WHERE state='queued' ORDER BY created_at LIMIT 1) RETURNING *").get(now()) as Job | undefined;
    if (active) {
      try {
        active.run_id = await acquireRun(active.owner,active.warehouse_code,active.trigger,active.id);
        db.prepare('UPDATE local_jobs SET run_id=? WHERE id=?').run(active.run_id,active.id);
        await syncWarehouse(active.owner,active.warehouse_code,active.trigger,active.run_id);
        db.prepare("UPDATE local_jobs SET state='complete',message='采集完成',updated_at=? WHERE id=?").run(now(),active.id);
      } catch(error) {
        if (active.run_id) await failRun(active.run_id,error instanceof Error ? error.message : '采集失败');
        db.prepare("UPDATE local_jobs SET state='failed',message=?,updated_at=? WHERE id=?").run(error instanceof Error ? error.message : '采集失败',now(),active.id);
      }
      active = undefined;
    } else await new Promise(r=>setTimeout(r,2000));
  }
} finally { clearInterval(timer); clearInterval(groupTimer); groupAbort.abort(); await groupSync; db.prepare('DELETE FROM local_worker WHERE id=1').run(); }
