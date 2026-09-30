import { sqlite } from './sqlite.mjs';
import { randomUUID } from 'node:crypto';
import { shanghaiTimestamp } from './jackyun';

export function enqueue(owner: string, code: string, trigger = 'manual') {
  const db = sqlite(), now = new Date().toISOString();
  const id = randomUUID();
  db.prepare("INSERT OR IGNORE INTO local_jobs(id,owner,warehouse_code,trigger,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(id,owner,code,trigger,now,now);
  return db.prepare("SELECT * FROM local_jobs WHERE owner=? AND warehouse_code=? AND state IN ('queued','running')").get(owner,code) as {id:string;state:string};
}
export function workerActive() {
  const row = sqlite().prepare('SELECT heartbeat,schedule_enabled FROM local_worker WHERE id=1').get();
  return !!row && row.schedule_enabled === 1 && Date.now() - Date.parse(String(row.heartbeat)) < 90000;
}
export function enqueueDaily(local = shanghaiTimestamp()) {
  if (local.slice(11) < '08:00:00') return;
  const db=sqlite(),date=local.slice(0,10);
  for (const t of db.prepare('SELECT owner,code FROM warehouses WHERE schedule_enabled=1').all()) {
    const done=db.prepare('SELECT 1 FROM daily_slots WHERE owner=? AND warehouse_code=? AND date=?').get(t.owner,t.code,date);
    const attempts=db.prepare('SELECT COUNT(*) AS n,MAX(updated_at) AS last FROM local_jobs WHERE owner=? AND warehouse_code=? AND trigger=?').get(t.owner,t.code,`daily:${date}`)!;
    if (!done && Number(attempts.n)<3 && (!attempts.last || Date.now()-Date.parse(String(attempts.last))>300000)) enqueue(String(t.owner),String(t.code),`daily:${date}`);
  }
}
