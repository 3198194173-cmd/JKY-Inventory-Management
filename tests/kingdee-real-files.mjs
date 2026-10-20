import { Worker } from 'node:worker_threads';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('..'), source = resolve(root, '资料/金蝶/原始导出/2026-10-19');
const folder = resolve('.sites-runtime/tests/kingdee-real-files'); mkdirSync(folder, { recursive: true });
const names = { companySales: '销售出库汇总报表_2026101914055631_140068.xlsx', companyStock: '物料收发汇总表_2026101914111062_140068.xlsx', storeSales: '销售明细表-20261019141745.xlsx', storeStock: '库存查询表-20261019141920.xlsx', prices: '销售价目表_2026101917162424_140068.xlsx' };
const files = Object.entries(names).map(([kind, name]) => ({ kind, name, path: resolve(source, name) }));
files.push({ kind: 'legacy', name: 'casebang 存销明细 2026.10.09.xlsx', path: resolve(root, '资料/金蝶/目标模板/casebang 存销明细 2026.10.09.xlsx') });
const output = resolve(folder, 'report.json');
const started = Date.now();
await new Promise((accept, reject) => {
  const worker = new Worker(resolve('build-node/kingdee-import.mjs'), { workerData: { files, output, rules: JSON.parse(readFileSync('data/kingdee-default-rules.json', 'utf8')) }, resourceLimits: { maxOldGenerationSizeMb: 768 } });
  worker.once('message', message => message.ok ? accept() : reject(new Error(message.error)));
  worker.once('error', reject);
  worker.once('exit', code => { if (code) reject(new Error('Worker exit ' + code)); });
});
const report = JSON.parse(readFileSync(output, 'utf8'));
assert.equal(report.summary.goods, 43927);
assert.equal(report.summary.totals.companySales, '131412');
assert.equal(report.summary.totals.storeSales, '3385');
assert.equal(report.summary.totals.inner, '1313426');
assert.equal(report.summary.totals.outer, '55849');
assert.equal(report.summary.totals.companyStock, '1369275');
assert.equal(report.summary.totals.storeStock, '67009');
assert.equal(report.summary.unmatchedConfiguredWarehouses.length, 0);
assert.deepEqual(report.sources.map(item => item.rows), [18624,39934,3704,7659,65851,40578]);
assert.equal(report.template.columns.length, 92);
assert.equal(report.template.frozenColumns, 6);
assert.equal(report.rows.filter(row => row.legacy).length, 40578);
const sample = report.rows.find(row => row.code === 'C.Q.CB.AP.00.0156');
assert.equal(sample.legacy.row, 23210);
assert.equal(sample.legacy.values[81], '8'); assert.equal(sample.legacy.values[84], '65'); assert.equal(sample.legacy.values[86], '75');
assert.equal(sample.companyStock, '87'); assert.equal(sample.companyAmount, '864.2667');
console.log(JSON.stringify({ elapsedSeconds: (Date.now() - started) / 1000, goods: report.summary.goods, totals: report.summary.totals,
  unmatchedConfiguredWarehouses: report.summary.unmatchedConfiguredWarehouses, sourceCounts: report.sources.map(item => ({ kind: item.kind, rows: item.rows, total: item.total })) }, null, 2));
