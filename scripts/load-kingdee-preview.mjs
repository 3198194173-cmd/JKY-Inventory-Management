// Explicit local demonstration import. Credentials stay in the local preview state.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const login = JSON.parse(await readFile('.sites-runtime/platform-preview/latest.json', 'utf8'));
const url = new URL(login.url);
if (!login.testOnly || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !resolve(login.database).startsWith(resolve('.sites-runtime/platform-preview/current') + sep)) throw new Error('仅允许向显式启用的本机隔离测试预览导入');
const response = await fetch(url.origin + '/api/session', { method: 'POST', headers: { origin: url.origin }, body: new URLSearchParams({ username: login.username, password: login.password }), redirect: 'manual' });
if (response.status !== 303) throw new Error('本机预览测试登录失败');
const cookie = response.headers.getSetCookie().find(value => value.startsWith('inventory_session='))?.split(';')[0];
if (!cookie) throw new Error('未取得测试会话');
const self = await fetch(url.origin + '/api/session', { headers: { cookie } });
if ((await self.json()).account?.name !== 'preview') throw new Error('不是预期的本机测试账户');
const source = resolve('../资料/金蝶/原始导出/2026-10-19');
const names = { companySales: '销售出库汇总报表_2026101914055631_140068.xlsx', companyStock: '物料收发汇总表_2026101914111062_140068.xlsx', storeSales: '销售明细表-20261019141745.xlsx', storeStock: '库存查询表-20261019141920.xlsx', prices: '销售价目表_2026101917162424_140068.xlsx' };
const form = new FormData();
for (const [kind, name] of Object.entries(names)) form.append(kind, new File([await readFile(resolve(source, name))], name));
const masterName = 'casebang 存销明细 2026.10.09.xlsx';
form.append('legacy', new File([await readFile(resolve('../资料/金蝶/目标模板', masterName))], masterName));
form.append('inheritance',JSON.stringify({period:{start:'2026-10-01',end:'2026-10-31',stockDate:'2026-10-19'}}));
const started = Date.now();
const imported = await fetch(url.origin + '/api/kingdee/imports', { method: 'POST', headers: { cookie, origin: url.origin }, body: form });
const payload = await imported.json();
if (!imported.ok) throw new Error(payload.error || '本地导入失败');
const { batch } = payload;
assert.equal(batch.summary.goods, 43925); assert.equal(batch.summary.totals.companyStock, '222010'); assert.equal(batch.summary.unmatchedConfiguredWarehouses.length, 0);
const out = resolve('outputs/kingdee-inheritance-20261023'); await mkdir(out, { recursive: true });
const excel = await fetch(url.origin + '/api/kingdee/export?batch=' + batch.id, { headers: { cookie } });
if (!excel.ok) throw new Error('明细导出失败');
await writeFile(resolve(out, '金蝶存销明细_雏形.xlsx'), Buffer.from(await excel.arrayBuffer()));
await writeFile(resolve(out, 'import-summary.json'), JSON.stringify(batch, null, 2));
console.log(JSON.stringify({ url: url.origin + '/kingdee', elapsedSeconds: (Date.now() - started) / 1000, batch: batch.id, goods: batch.summary.goods, totals: batch.summary.totals,
  innerWarehouses: batch.rules.warehouses.members.filter(row => row.group === 'inner').length, outerWarehouses: batch.rules.warehouses.members.filter(row => row.group === 'outer').length,
  export: resolve(out, '金蝶存销明细_雏形.xlsx') }, null, 2));
