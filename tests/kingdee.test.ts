import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import preset from '../data/kingdee-default-rules.json';
import { zipTextFiles } from '../lib/zip';
import { readKingdeeXlsx } from '../lib/kingdee-xlsx';
import { importKingdeeFiles } from '../lib/kingdee-import';
import { kingdeeWorkbook } from '../lib/kingdee-export';
import { createKingdeeImport, getKingdeeBatch, kingdeeRules, kingdeeView, kingdeeExportData, saveKingdeeWarehouses, readKingdeeSubmission } from '../lib/kingdee-store';
import type { KingdeeRules } from '../lib/kingdee-types';
import { defaultKingdeeTemplate, sheetValue } from '../lib/kingdee-sheet';
import { assessPreparation, preparationChoices } from '../lib/kingdee-preparation';
import type { SourceReferences } from '../lib/kingdee-types';

mkdirSync('.sites-runtime/tests', { recursive: true });
const root = mkdtempSync(resolve('.sites-runtime/tests/kd-unit-'));
process.env.INVENTORY_DB_PATH = join(root, 'auth.sqlite');
process.env.KINGDEE_DB_PATH = join(root, 'kingdee.sqlite');
process.env.KINGDEE_STORAGE_DIR = join(root, 'files');
const rules = structuredClone(preset) as KingdeeRules;
rules.warehouses.members = [{ name: '内仓', group: 'inner' }, { name: '外仓', group: 'outer' }];
function xlsx(rows: Record<string, string>[], sheet = 'Sheet1') {
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return Buffer.from(zipTextFiles({
    'xl/workbook.xml': `<workbook><sheets><sheet name="${sheet}" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/styles.xml': '<styleSheet><fonts><font><sz val="10"/><name val="宋体"/></font></fonts><fills><fill><patternFill patternType="none"/></fill></fills><cellXfs><xf fontId="0" fillId="0" numFmtId="0"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows.map((row, index) => `<row r="${index + 1}">${Object.entries(row).map(([key, value]) => `<c r="${key}${index + 1}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`,
  }));
}
const headers = { A: '物料编码', B: '物料名称' };
const fixture = {
  companySales: xlsx([{}, {}, { ...headers, C: '出库数量', D: '客户名称', E: '是否赠品' }, { A: 'A', B: '商品甲', C: '5', E: '是' }, { A: 'A', B: '商品甲', C: '-1', E: '否' }, { A: 'B', B: '商品乙', C: '0' }, { A: '合计', C: '4' }]),
  companyStock: xlsx([{}, {}, {}, { ...headers, C: '仓库名称', J: '结存' }, { J: '数量' }, { A: 'A', B: '商品甲', C: '内仓', J: '2' }, { A: 'A', B: '商品甲', C: '外仓', J: '3' }, { A: 'A', B: '商品甲', C: '名单外仓', J: '100' }, { A: 'B', B: '商品乙', C: '内仓', J: '10' }, { A: '合计', J: '115' }]),
  storeSales: xlsx([{}, {}, { A: '商品编码', B: '商品名称', C: '基本数量' }, { A: 'A', B: '商品甲', C: '2' }, { A: 'A', B: '商品甲', C: '-1' }, { A: 'B', B: '商品乙', C: '0' }, { A: '合计', C: '1' }]),
  storeStock: xlsx([{}, {}, { A: '商品编码', B: '商品名称', C: '即时库存（基本）' }, { A: 'A', B: '商品甲', C: '7' }, { A: 'B', B: '商品乙', C: '0' }, { A: '合计', C: '7' }]),
  prices: xlsx([{ A: '物料编码', B: '价格', C: '编号', D: '币别', E: '含税', F: '价目对象', G: '整单状态', H: '销售组织' }, ...['A', 'B'].map(code => ({ A: code, B: code === 'A' ? '2.5' : '0', C: 'P1', D: '人民币', E: '是', F: '按物料', G: '已审核', H: 'CASEBANG事业部' }))]),
};
function files() {
  return Object.entries(fixture).map(([kind, bytes]) => { const path = join(root, kind + '.xlsx'); writeFileSync(path, bytes); return { kind: kind as keyof typeof fixture, name: kind + '.xlsx', path }; });
}

test('名单范围、赠品、负数、真实零价和精确金额均保留，不按多仓多单据重复放大', async () => {
  const report = await importKingdeeFiles(files(), rules);
  const a = report.rows.find(row => row.code === 'A')!, b = report.rows.find(row => row.code === 'B')!;
  assert.equal(a.companySales, '4'); assert.equal(a.storeSales, '1'); assert.equal(a.combinedSales, '5');
  assert.equal(a.companyStock, '5'); assert.equal(a.companyAmount, '12.5'); assert.equal(a.storeAmount, '17.5'); assert.equal(a.totalAmount, '30');
  assert.equal(b.price, '0'); assert.equal(b.companyAmount, '0'); assert.equal(a.category, null);
  assert.equal(report.summary.warehouses.find(row => row.name === '名单外仓')!.group, 'outside');
  assert.equal(report.summary.totals.companyStock, '15');
});

test('错误表头、损坏文件和合计不一致拒绝导入', async () => {
  assert.throws(() => readKingdeeXlsx(Buffer.from('not xlsx')), /不是有效/);
  const corrupted = Buffer.from(fixture.companySales); corrupted[corrupted.indexOf(Buffer.from('商品甲'))] ^= 1;
  assert.throws(() => readKingdeeXlsx(corrupted), /校验/);
  const inputs = files(); writeFileSync(inputs[0].path, xlsx([{}, {}, { ...headers, C: '出库数量', D: '客户名称' }, { A: 'A', C: '5' }, { A: '合计', C: '6' }]));
  await assert.rejects(importKingdeeFiles(inputs, rules), /合计不一致/);
});

test('导出可读回，缺失为空、金额保留数值，编码与特殊字符不作为公式', async () => {
  const report = await importKingdeeFiles(files(), rules);
  report.rows[0].code = '=TEST'; report.rows[0].name = '<商品&名称>';
  const bytes = kingdeeWorkbook({ ...report, id: 'test', state: 'ready', createdAt: '2026-10-20T00:00:00Z', error: '' }, report.rows);
  const rows = readKingdeeXlsx(Buffer.from(bytes), { sheet: '明细' });
  assert.equal(Object.keys(rows[0].cells).length, 92);
  assert.equal(rows[1].cells.E, '=TEST'); assert.equal(rows[1].cells.F, '<商品&名称>'); assert.equal(rows[1].cells.CL, '12.5'); assert.equal(rows[1].cells.A, undefined);
  assert.equal(rows[0].cells.CD, '本批公司销量'); assert.equal(rows[0].cells.CI, '本批公司结存');
  assert.match(readKingdeeXlsx(Buffer.from(bytes), { sheet: '来源与说明' })[1].cells.B, /未宣称历史年月/);
});

test('92列历史缓存与原表顺序完整保留，本批数量和新价不覆盖原表历史值', async () => {
  const inputs = files(), path = join(root, 'legacy.xlsx');
  writeFileSync(path, xlsx([Object.fromEntries(defaultKingdeeTemplate.columns.map(c => [c.key, c.label])), { A: '分类', B: '0', D: '0', E: 'B', F: '商品乙', G: '999', CD: '88', CG: '65', CI: '75', CK: '9.9341', CN: '804.6621' }, { E: 'A', F: '商品甲', G: '-2', CD: '8' }], '明细'));
  const report = await importKingdeeFiles([...inputs, { kind: 'legacy', name: '旧表.xlsx', path }], rules);
  assert.equal(report.template!.columns.length, 92); assert.equal(report.template!.frozenColumns, 6);
  assert.deepEqual(report.rows.map(row => row.code), ['B', 'A']);
  const b = report.rows[0];
  assert.equal(sheetValue(b, 6, 'current'), '999'); assert.equal(sheetValue(b, 1, 'current'), '0');
  assert.equal(sheetValue(b, 81, 'original'), '88'); assert.equal(sheetValue(b, 81, 'current'), '0');
  assert.equal(sheetValue(b, 88, 'original'), '9.9341'); assert.equal(sheetValue(b, 88, 'current'), '0');
  const batch = { ...report, id: 'test', state: 'ready', createdAt: '2026-10-20T00:00:00Z', error: '' };
  const original = readKingdeeXlsx(Buffer.from(kingdeeWorkbook(batch, report.rows, 'original')), { sheet: '原表对照' });
  assert.equal(original[0].cells.CD, '10.1-8公司销量'); assert.equal(original[1].cells.CD, '88'); assert.equal(original[1].cells.G, '999');
  assert.equal(original[1].cells.CK, '9.9341'); assert.equal(original[1].cells.CN, '804.6621');
  const current = readKingdeeXlsx(Buffer.from(kingdeeWorkbook(batch, report.rows)), { sheet: '明细' });
  assert.equal(current[1].cells.G, '999'); assert.equal(current[1].cells.CD, '0'); assert.equal(current[1].cells.CI, '10');
});

test('金蝶业务库按账户隔离，规则重算保留旧版，失败不会替换上次成功批次', async () => {
  saveKingdeeWarehouses('owner-a', 'a', rules.warehouses.members);
  const uploads = Object.entries(fixture).map(([kind, bytes]) => ({ kind: kind as keyof typeof fixture, name: kind + '.xlsx', bytes }));
  const a = await createKingdeeImport('owner-a', 'a', uploads);
  assert.equal(kingdeeView('owner-b').batch, null);
  assert.throws(() => getKingdeeBatch('owner-b', a.id), /找不到/);
  assert.throws(() => kingdeeExportData('owner-b', a.id), /找不到/);
  saveKingdeeWarehouses('owner-a', 'a', [{ name: '内仓', group: 'inner' }]);
  assert.equal(kingdeeView('owner-a').rulesChanged, true);
  assert.equal(kingdeeRules('owner-b').warehouses.members.length, 10);
  const b = await createKingdeeImport('owner-a', 'a', [], a.id);
  assert.equal(b.summary.totals.companyStock, '12');
  assert.equal(getKingdeeBatch('owner-a', a.id).summary.totals.companyStock, '15');
  await assert.rejects(createKingdeeImport('owner-a', 'a', uploads.map(row => row.kind === 'prices' ? { ...row, bytes: Buffer.from('invalid') } : row)), /不是有效/);
  assert.equal(kingdeeView('owner-a').batch!.id, b.id);
  assert.equal(kingdeeView('owner-a', new URLSearchParams({ q: '%_' })).totalRows, 0);
  assert.equal(kingdeeView('owner-a', new URLSearchParams({ column: 'CD', contains: '4' })).totalRows, 1);
  assert.equal(kingdeeView('owner-a', new URLSearchParams({ column: 'CD', direction: 'asc' })).rows[0].code, 'B');
  assert.equal(kingdeeView('owner-a', new URLSearchParams({ column: 'CI', contains: '%_' })).totalRows, 0);
  assert.equal(kingdeeView('owner-a', new URLSearchParams({ sheet: 'original' })).totalRows, 0);
  assert.equal(readFileSync(process.env.KINGDEE_DB_PATH!).subarray(0, 16).toString(), 'SQLite format 3\0');
});

test('数据准备按实际来源判定，接口待联调不伪造就绪，文件与总大小有明确阻塞原因', () => {
  const choices = preparationChoices(null);
  const selected = Object.fromEntries(Object.keys(fixture).map(kind => [kind, { name: kind + '.xlsx', size: 100 }]));
  const pending = assessPreparation(choices, selected, []);
  assert.equal(pending.ready, false); assert.equal(pending.readyCount, 3); assert.match(pending.issues.join(''), /全量采集并采用/);
  const uploads = preparationChoices(null, 'upload');
  assert.equal(assessPreparation(uploads, selected, []).ready, true);
  assert.equal(assessPreparation(uploads, { ...selected, storeStock: { name: '错误.csv', size: 100 } }, []).ready, false);
  assert.match(assessPreparation(uploads, Object.fromEntries(Object.keys(fixture).map(kind => [kind, { name: kind + '.xlsx', size: 11 * 1024 * 1024 }])), []).issues.join(''), /合计不能超过50MB/);
  uploads.prices = { mode: 'saved', batchId: 'missing' };
  assert.equal(assessPreparation(uploads, selected, []).readyCount, 4);
});

test('上传新门店文件并显式复用其余来源，按账户校验并留存来源版本，旧批次不改变', async () => {
  const owner = 'preparation-owner';
  saveKingdeeWarehouses(owner, 'actor', rules.warehouses.members);
  const uploads = Object.entries(fixture).map(([kind, bytes]) => ({ kind: kind as keyof typeof fixture, name: kind + '.xlsx', bytes }));
  const first = await createKingdeeImport(owner, 'actor', uploads);
  const choices = preparationChoices(first, 'saved');
  const selected = assessPreparation(choices, {}, [first]);
  assert.equal(selected.ready, true); assert.equal(selected.readyCount, 5);
  const references: SourceReferences = { ...selected.references }; delete references.storeStock;
  const updated = xlsx([{}, {}, { A: '商品编码', B: '商品名称', C: '即时库存（基本）' }, { A: 'A', B: '商品甲', C: '70' }, { A: 'B', B: '商品乙', C: '0' }, { A: '合计', C: '70' }]);
  const second = await createKingdeeImport(owner, 'actor', [{ kind: 'storeStock', name: '门店库存新版.xlsx', bytes: updated }], undefined, references);
  assert.equal(first.summary.totals.storeStock, '7'); assert.equal(second.summary.totals.storeStock, '70');
  assert.equal(second.summary.totals.companyStock, '15');
  assert.equal(second.sources.find(item => item.kind === 'companyStock')!.originBatchId, first.id);
  assert.equal(second.sources.find(item => item.kind === 'storeStock')!.originBatchId, undefined);
  assert.equal(getKingdeeBatch(owner, first.id).summary.totals.storeStock, '7');
  await assert.rejects(createKingdeeImport('another-owner', 'actor', [], undefined, selected.references), /找不到/);
  await assert.rejects(createKingdeeImport(owner, 'actor', uploads, undefined, selected.references), /不能同时上传和复用/);
  const form = new FormData(); form.append('sourceReferences', JSON.stringify(selected.references));
  assert.deepEqual((await readKingdeeSubmission(new Request('https://local.test/import', { method: 'POST', body: form }))).references, selected.references);
  const invalid = new FormData(); invalid.append('password', 'not-a-real-password');
  await assert.rejects(readKingdeeSubmission(new Request('https://local.test/import', { method: 'POST', body: invalid })), /来源类型无效/);
});
