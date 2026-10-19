import { createHash } from 'node:crypto';
import { discoverWarehouses, type AvailableWarehouse } from './jackyun-warehouses';
import { serverConfig } from './server-config';
import { loadWarehouses, warehouseCode } from './inventory-store';
import { assertOwnerActive } from './accounts';
import { sqlite } from './sqlite.mjs';
import { enqueue } from './local-jobs';

let cache: { key: string; expires: number; loading: boolean; pending: Promise<AvailableWarehouse[]> } | undefined;
// All accounts currently use the same server-side Jackyun application. Cache
// only its complete catalogue, never individual users' saved warehouse state.
export function availableWarehouses(refresh = false): Promise<AvailableWarehouse[]> {
  const config = serverConfig();
  if (!config.configured) throw new Error('尚未配置吉客云 AppSecret，请联系管理员');
  const key = createHash('sha256').update(config.appkey + ':' + config.secret).digest('hex');
  if (!cache || cache.key !== key || (!cache.loading && (refresh || cache.expires <= Date.now()))) {
    const next = { key, expires: 0, loading: true, pending: discoverWarehouses(config.appkey, config.secret) };
    cache = next;
    void next.pending.then(() => { next.loading = false; next.expires = Date.now() + 60_000; }, () => { if (cache === next) cache = undefined; });
  }
  return cache.pending;
}

export async function addDiscoveredWarehouse(owner: string, input: unknown, initialize: boolean, discover = () => availableWarehouses(true)) {
  assertOwnerActive(owner);
  const code = warehouseCode(input), warehouse = (await discover()).find(w => w.code === code);
  if (!warehouse) throw new Error('该仓库不在当前吉客云应用的可用列表中，请刷新列表');
  // Resolve identity/name from the server catalogue, never client-supplied fields.
  const db = sqlite();
  db.exec('BEGIN IMMEDIATE');
  let job: ReturnType<typeof enqueue> | undefined;
  try {
    assertOwnerActive(owner);
    const existing = db.prepare('SELECT warehouse_id FROM warehouses WHERE owner=? AND code=?').get(owner, code);
    if (existing?.warehouse_id && existing.warehouse_id !== warehouse.warehouseId) throw new Error('该编码的仓库身份已改变，请管理员核对；原历史已保留');
    db.prepare('INSERT OR IGNORE INTO warehouses(owner,code,name,warehouse_id,created_at) VALUES(?,?,?,?,?)').run(owner, code, warehouse.name, warehouse.warehouseId, new Date().toISOString());
    // Duplicate submits preserve names/history and reuse the active job.
    if (initialize) job = enqueue(owner, code);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { warehouses: await loadWarehouses(owner), queued: !!job, job };
}
