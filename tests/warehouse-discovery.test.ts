import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { discoverWarehouses } from '../lib/jackyun-warehouses';
import { jackyunSign } from '../lib/jackyun';
import { addDiscoveredWarehouse, availableWarehouses } from '../lib/warehouse-discovery';
import { bindCompanyAccount } from '../lib/accounts';
import { sqlite } from '../lib/sqlite.mjs';

const row = (code: string, id = '2391620541187785472') => ({ warehouseCode: code, warehouseName: code + ' 官方仓库', warehouseId: id, isBlockup: 0, isDelete: 0 });
const response = (rows: unknown[]) => Response.json({ code: 200, result: { data: { warehouseInfo: rows } } });
test('按官方仓库接口分页签名，无需预先知道编码；保留长 ID，不因短页截断', async () => {
  let calls = 0;
  const fetcher = (async (url, init) => {
    assert.equal(String(url), 'https://open.jackyun.com/open/openapi/do');
    const params = Object.fromEntries(new URLSearchParams(String(init?.body)));
    assert.equal(params.method, 'erp.warehouse.get');
    assert.equal(params.sign, jackyunSign(params, 'offline-secret'));
    const input = JSON.parse(params.bizcontent);
    assert.deepEqual(input, { pageIndex: calls, pageSize: 50, includeDeleteAndBlockup: 0 });
    calls++;
    // Numeric long ID must be parsed without IEEE754 rounding.
    if (calls === 1) return new Response('{"code":200,"result":{"data":{"warehouseInfo":[{"warehouseId":2391620541187785472,"warehouseCode":"CK031","warehouseName":"泰国仓","isBlockup":0,"isDelete":0}]}}}');
    return calls === 2 ? response([row('CK007', '2391620541187785473')]) : response([]);
  }) as typeof fetch;
  assert.deepEqual(await discoverWarehouses('offline-key', 'offline-secret', fetcher), [
    { code: 'CK007', name: 'CK007 官方仓库', warehouseId: '2391620541187785473' },
    { code: 'CK031', name: '泰国仓', warehouseId: '2391620541187785472' },
  ]);
  assert.equal(calls, 3);
});
test('过滤停用/删除仓库，支持成功空列表', async () => {
  let page = 0;
  const list = await discoverWarehouses('k', 's', (async () => page++ ? response([]) : response([{ ...row('OFF'), isBlockup: 1 }, { ...row('DEL', '2'), isDelete: true }, row('OK', '3')])) as typeof fetch);
  assert.deepEqual(list.map(w => w.code), ['OK']);
  assert.deepEqual(await discoverWarehouses('k', 's', (async () => response([])) as typeof fetch), []);
});
test('重复分页、缺字段、权限/网络错误不当作空列表，错误中不回显远程敏感内容', async () => {
  await assert.rejects(() => discoverWarehouses('k', 's', (async () => response([row('CK031')])) as typeof fetch), /重复/);
  for (const body of [ { code: 200, result: { data: {} } }, { code: 200, result: { data: { warehouseInfo: [row('CK031')] }, noPrivilegeItem: ['warehouseName'] } }, { code: 200, result: { data: { warehouseInfo: [{ warehouseCode: 'CK031' }] } } } ]) {
    await assert.rejects(() => discoverWarehouses('k', 's', (async () => Response.json(body)) as typeof fetch));
  }
  await assert.rejects(() => discoverWarehouses('k', 's', (async () => Response.json({ code: 0, subCode: 'denied', msg: 'PRIVATE-SECRET' })) as typeof fetch), e => e instanceof Error && e.message.includes('erp.warehouse.get') && !e.message.includes('PRIVATE-SECRET'));
  await assert.rejects(() => discoverWarehouses('k', 's', (async () => new Response('PRIVATE-SECRET', { status: 403 })) as typeof fetch), /HTTP 403/);
  let calls = 0;
  await assert.rejects(() => discoverWarehouses('k', 's', (async () => response([row('C' + calls, String(++calls))])) as typeof fetch), /100 页/);
});

test('仓库目录合并并发请求，刷新重新拉取，失败可重试且更换应用不复用旧缓存', async () => {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.JACKYUN_APP_KEY, previousSecret = process.env.JACKYUN_APP_SECRET;
  let requests = 0, fail = false;
  Object.assign(process.env, { JACKYUN_APP_KEY: 'cache-test-key', JACKYUN_APP_SECRET: 'offline-cache-test' });
  globalThis.fetch = (async (_url, init) => {
    requests++;
    await new Promise(resolve => setTimeout(resolve, 5));
    const params = new URLSearchParams(String(init?.body)), input = JSON.parse(params.get('bizcontent')!);
    if (fail) return Response.json({ code: 0, subCode: 'denied' });
    return response(input.pageIndex === 0 ? [row(String(params.get('appkey')))] : []);
  }) as typeof fetch;
  try {
    const first = availableWarehouses(), concurrent = availableWarehouses(true);
    assert.equal(first, concurrent);
    assert.equal((await first)[0].code, 'cache-test-key'); assert.equal(requests, 2);
    await availableWarehouses(); assert.equal(requests, 2);
    await availableWarehouses(true); assert.equal(requests, 4);
    fail = true; await assert.rejects(() => availableWarehouses(true), /erp.warehouse.get/);
    fail = false; await availableWarehouses(); assert.equal(requests, 7);
    process.env.JACKYUN_APP_KEY = 'changed-app';
    assert.equal((await availableWarehouses())[0].code, 'changed-app'); assert.equal(requests, 9);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.JACKYUN_APP_KEY; else process.env.JACKYUN_APP_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.JACKYUN_APP_SECRET; else process.env.JACKYUN_APP_SECRET = previousSecret;
  }
});

mkdirSync('.sites-runtime/tests', { recursive: true });
Object.assign(process.env, { INVENTORY_DB_PATH: resolve(`.sites-runtime/tests/discovery-${randomUUID()}.sqlite`), INVENTORY_DINGTALK_LOGIN_ENABLED: 'true', INVENTORY_OWNER_ID: 'discovery-admin', DINGTALK_CORP_ID: 'discovery-corp', DINGTALK_ADMIN_UNION_ID: 'admin-union' });
test('服务器解析仓库身份，添加和入队原子完成，隔离账户且重试不覆盖已有数据', async () => {
  const person = (id: string) => ({ corpId: 'discovery-corp', userId: id, unionId: id + '-union', name: id, avatar: '' });
  bindCompanyAccount(person('admin'));
  const a = bindCompanyAccount(person('a')), b = bindCompanyAccount(person('b')), db = sqlite();
  let calls = 0;
  const discover = async () => { calls++; return [{ code: 'CK031', name: '官方仓', warehouseId: '2391620541187785472' }]; };
  await assert.rejects(() => addDiscoveredWarehouse(a.data_owner, 'UNKNOWN', true, discover), /可用列表/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM warehouses WHERE owner=?').get(a.data_owner)!.n, 0);
  const added = await addDiscoveredWarehouse(a.data_owner, 'CK031', true, discover);
  assert.equal(added.queued, true); assert.equal(added.warehouses[0].name, '官方仓'); assert.equal(added.warehouses[0].warehouseId, '2391620541187785472');
  db.prepare("UPDATE warehouses SET name='用户别名' WHERE owner=?").run(a.data_owner);
  const again = await addDiscoveredWarehouse(a.data_owner, 'CK031', true, discover);
  assert.equal(again.warehouses[0].name, '用户别名'); assert.equal(again.job?.id, added.job?.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM local_jobs WHERE owner=?').get(a.data_owner)!.n, 1);
  await addDiscoveredWarehouse(b.data_owner, 'CK031', false, discover);
  assert.equal(db.prepare('SELECT name FROM warehouses WHERE owner=?').get(b.data_owner)!.name, '官方仓');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM local_jobs WHERE owner=?').get(b.data_owner)!.n, 0);
  await assert.rejects(() => addDiscoveredWarehouse(a.data_owner, 'CK031', true, async () => [{ code: 'CK031', name: '另一个仓', warehouseId: '2' }]), /身份已改变/);
  db.exec("CREATE TRIGGER fail_discovery_job BEFORE INSERT ON local_jobs WHEN NEW.warehouse_code='ROLLBACK' BEGIN SELECT RAISE(ABORT,'test rollback'); END;");
  await assert.rejects(() => addDiscoveredWarehouse(a.data_owner, 'ROLLBACK', true, async () => [{ code: 'ROLLBACK', name: '回滚仓', warehouseId: '3' }]), /test rollback/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM warehouses WHERE code='ROLLBACK'").get()!.n, 0);
  db.prepare("UPDATE accounts SET status='disabled' WHERE id=?").run(b.id);
  const before = calls; await assert.rejects(() => addDiscoveredWarehouse(b.data_owner, 'CK031', true, discover), /不可用/); assert.equal(calls, before);
});
