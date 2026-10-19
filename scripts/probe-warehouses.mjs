// Read-only live check. Run from web-app:
// node --env-file=.dev.vars scripts/probe-warehouses.mjs
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const appkey = process.env.JACKYUN_APP_KEY, secret = process.env.JACKYUN_APP_SECRET;
if (!appkey || !secret) { console.error('请通过本地环境配置 JACKYUN_APP_KEY 和 JACKYUN_APP_SECRET；不要将密钥粘贴到日志中。'); process.exit(1); }
const compiled = resolve(root, '.sites-runtime/warehouse-discovery-probe.mjs');
await build({ entryPoints: [resolve(root, 'lib/jackyun-warehouses.ts')], outfile: compiled, bundle: true, platform: 'node', format: 'esm', target: 'node24' });
const { discoverWarehouses } = await import(pathToFileURL(compiled).href);
const output = resolve(root, 'outputs/warehouse-discovery', new Date().toISOString().replace(/[:.]/g, '-'));
const pages = [], started = Date.now();
await mkdir(output, { recursive: true });
try {
  const warehouses = await discoverWarehouses(appkey, secret, async (url, init) => {
    const input = JSON.parse(new URLSearchParams(String(init.body)).get('bizcontent'));
    const before = Date.now(), response = await fetch(url, init);
    let body;
    try { body = await response.clone().json(); } catch { /* Collector validates JSON. */ }
    const page = { pageIndex: input.pageIndex, http: response.status, code: body?.code, subCode: String(body?.subCode ?? '').replace(/[^\w-]/g, '').slice(0, 30), rows: Array.isArray(body?.result?.data?.warehouseInfo) ? body.result.data.warehouseInfo.length : null, dataIsNull: body?.result?.data === null, dataKeys: body?.result?.data && typeof body.result.data === 'object' ? Object.keys(body.result.data) : [], milliseconds: Date.now() - before };
    pages.push(page);
    console.log(`仓库列表第 ${page.pageIndex + 1} 页：HTTP ${page.http}，code=${page.code ?? '缺失'}，${page.rows ?? '格式待核验'} 行，${(page.milliseconds / 1000).toFixed(2)} 秒`);
    return response;
  });
  await writeFile(resolve(output, 'warehouses.json'), JSON.stringify(warehouses, null, 2), 'utf8');
  await writeFile(resolve(output, 'summary.json'), JSON.stringify({ method: 'erp.warehouse.get', source: 'live', complete: true, count: warehouses.length, elapsedMilliseconds: Date.now() - started, pages, warehouseFilter: { includeDeleteAndBlockup: 0 }, knownWarehouseFound: warehouses.some(w => w.code === 'CK031') }, null, 2), 'utf8');
  console.log(`实际接口验证成功：${warehouses.length} 个可用仓库，合计 ${((Date.now() - started) / 1000).toFixed(2)} 秒。`);
  console.log(JSON.stringify(warehouses.slice(0, 8), null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : '仓库查询失败';
  await writeFile(resolve(output, 'summary.json'), JSON.stringify({ method: 'erp.warehouse.get', source: 'live', complete: false, elapsedMilliseconds: Date.now() - started, pages, error: message }, null, 2), 'utf8');
  console.error(message); process.exitCode = 1;
}
console.log(`结果目录：${output}`);
