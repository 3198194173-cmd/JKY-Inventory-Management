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
import { defaultKingdeeTemplate, sheetValue, sheetCellNote, sheetColumns } from '../lib/kingdee-sheet';
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
  assert.equal(Object.keys(rows[0].cells).length, 99);
  assert.equal(rows[1].cells.E, '=TEST'); assert.equal(rows[1].cells.F, '<商品&名称>'); assert.equal(rows[1].cells.CS, '12.5'); assert.equal(rows[1].cells.A, undefined);
  assert.equal(rows[0].cells.CK, '期间待确认公司销量'); assert.equal(rows[0].cells.CP, '时点待确认公司结存');
  assert.match(readKingdeeXlsx(Buffer.from(bytes), { sheet: '来源与说明' })[1].cells.B, /继承原表/);
});

test('92列历史缓存与原表顺序完整保留，本批数量和新价不覆盖原表历史值', async () => {
  const inputs = files(), path = join(root, 'legacy.xlsx');
  writeFileSync(path, xlsx([Object.fromEntries(defaultKingdeeTemplate.columns.map(c => [c.key, c.label])), { A: '分类', B: '0', D: '0', E: 'B', F: '商品乙', G: '999', CD: '88', CG: '65', CI: '75', CK: '9.9341', CN: '804.6621' }, { E: 'A', F: '商品甲', G: '-2', CD: '8' }], '明细'));
  const report = await importKingdeeFiles([...inputs, { kind: 'legacy', name: '旧表.xlsx', path }], rules);
  assert.equal(report.template!.columns.length, 92); assert.equal(report.template!.frozenColumns, 6);
  assert.deepEqual(report.rows.map(row => row.code), ['B', 'A']);
  const b = report.rows[0];
  assert.equal(sheetValue(b, 6, 'current'), '999'); assert.equal(sheetValue(b, 1, 'current'), '0');
  assert.equal(sheetValue(b, 81, 'original'), '88'); assert.equal(sheetValue(b, 81, 'current'), '88');
  assert.equal(sheetValue(b, 88, 'original'), '9.9341'); assert.equal(sheetValue(b, 88, 'current'), '0');
  const batch = { ...report, id: 'test', state: 'ready', createdAt: '2026-10-20T00:00:00Z', error: '' };
  const original = readKingdeeXlsx(Buffer.from(kingdeeWorkbook(batch, report.rows, 'original')), { sheet: '原表对照' });
  assert.equal(original[0].cells.CD, '10.1-8公司销量'); assert.equal(original[1].cells.CD, '88'); assert.equal(original[1].cells.G, '999');
  assert.equal(original[1].cells.CK, '9.9341'); assert.equal(original[1].cells.CN, '804.6621');
  const current = readKingdeeXlsx(Buffer.from(kingdeeWorkbook(batch, report.rows)), { sheet: '明细' });
  assert.equal(current[1].cells.G, '999'); assert.equal(current[1].cells.CD, '88'); assert.equal(current[1].cells.CI, '75');
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
  assert.equal(kingdeeView('owner-a', new URLSearchParams({ column: 'CK', contains: '4' })).totalRows, 1);
  assert.equal(kingdeeView('owner-a', new URLSearchParams({ column: 'CK', direction: 'asc' })).rows[0].code, 'B');
  assert.equal(kingdeeView('owner-a', new URLSearchParams({ column: 'CP', contains: '%_' })).totalRows, 0);
  assert.equal(kingdeeView('owner-a', new URLSearchParams({ sheet: 'original' })).totalRows, 0);
  assert.equal(readFileSync(process.env.KINGDEE_DB_PATH!).subarray(0, 16).toString(), 'SQLite format 3\0');
});

test('数据准备按实际来源判定，接口待联调不伪造就绪，文件与总大小有明确阻塞原因', () => {
  const choices = preparationChoices(null);
  const selected = {...Object.fromEntries(Object.keys(fixture).map(kind => [kind, { name: kind + '.xlsx', size: 100 }])),legacy:{name:'原明细.xlsx',size:100}};
  const pending = assessPreparation(choices, selected, []);
  assert.equal(pending.ready, false); assert.equal(pending.readyCount, 3); assert.equal(pending.requiredCount, 7); assert.match(pending.issues.join(''), /全量采集并采用/);
  const uploads = preparationChoices(null, 'upload');
  assert.equal(assessPreparation(uploads, selected, []).ready, true);
  assert.equal(assessPreparation(uploads, { ...selected, storeStock: { name: '错误.csv', size: 100 } }, []).ready, false);
  assert.match(assessPreparation(uploads, Object.fromEntries(Object.keys(fixture).map(kind => [kind, { name: kind + '.xlsx', size: 11 * 1024 * 1024 }])), []).issues.join(''), /合计不能超过50MB/);
  uploads.prices = { mode: 'saved', batchId: 'missing' };
  assert.equal(assessPreparation(uploads, selected, []).readyCount, 5);
});

test('上传新门店文件并显式复用其余来源，按账户校验并留存来源版本，旧批次不改变', async () => {
  const owner = 'preparation-owner';
  saveKingdeeWarehouses(owner, 'actor', rules.warehouses.members);
  const uploads = Object.entries(fixture).map(([kind, bytes]) => ({ kind: kind as keyof typeof fixture, name: kind + '.xlsx', bytes }));
  const master=xlsx([Object.fromEntries(defaultKingdeeTemplate.columns.map(c=>[c.key,c.label])),{E:'A',F:'商品甲'}],'明细');
  const first = await createKingdeeImport(owner, 'actor', [...uploads,{kind:'legacy',name:'原表.xlsx',bytes:master}]);
  const choices = preparationChoices(first, 'saved');
  const selected = assessPreparation(choices, {}, [first]);
  assert.equal(selected.ready, true); assert.equal(selected.readyCount, 6);
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

test('1000条分页保留整批并集和覆盖计数，切换100/500条不会改变统计及导出范围',async()=>{
  const owner='pagination-owner',bulk=Array.from({length:1205},(_,i)=>({A:'BULK-'+String(i).padStart(4,'0'),B:'分页商品',C:'内仓',J:'1'}));
  saveKingdeeWarehouses(owner,'actor',[{name:'内仓',group:'inner'}]);
  const stock=xlsx([{},{},{},{A:'物料编码',B:'物料名称',C:'仓库名称',J:'结存'},{J:'数量'},...bulk,{A:'合计',J:'1205'}]);
  const inputs=Object.entries(fixture).map(([kind,bytes])=>({kind:kind as keyof typeof fixture,name:kind+'.xlsx',bytes:kind==='companyStock'?stock:bytes}));
  const batch=await createKingdeeImport(owner,'actor',inputs),first=kingdeeView(owner),next=kingdeeView(owner,new URLSearchParams({page:'2',pageSize:'1000'}));
  assert.equal(first.totalRows,1207);assert.equal(first.pageSize,1000);assert.equal(first.rows.length,1000);assert.equal(next.rows.length,207);
  assert.equal(new Set([...first.rows,...next.rows].map(row=>row.code)).size,1207);
  assert.equal(first.coverage!.goods,1207);assert.equal(first.coverage!.companySales,2);assert.equal(first.coverage!.storeSales,2);assert.equal(first.coverage!.combinedSales,1207);assert.equal(first.coverage!.companyStock,1207);assert.equal(first.coverage!.legacy,0);
  assert.deepEqual(next.coverage,first.coverage);
  for(const size of [100,500]){const view=kingdeeView(owner,new URLSearchParams({pageSize:String(size)}));assert.equal(view.rows.length,size);assert.equal(view.totalRows,1207);assert.deepEqual(view.coverage,first.coverage);}
  assert.equal(kingdeeView(owner,new URLSearchParams({pageSize:'999999'})).pageSize,1000);
  const filtered=kingdeeView(owner,new URLSearchParams({q:'BULK-0000',pageSize:'1000'}));assert.equal(filtered.totalRows,1);assert.equal(filtered.coverage!.goods,1207);
  assert.equal(kingdeeExportData(owner,batch.id).rows.length,1207);
});

test('空白原因区分四维主档、独立销量、合计前提、名单结存和缺价，不把未知补0',async()=>{
  const report=await importKingdeeFiles(files(),rules),a=report.rows.find(row=>row.code==='A')!;
  assert.match(sheetCellNote(a,0,'current'),/旧明细/);assert.match(sheetCellNote(a,6,'current'),/历史/);
  const sparse={...a,storeSales:null,combinedSales:null,storeStock:null,price:null,priceStatus:'missing' as const,companyAmount:null,storeAmount:null,totalAmount:null};
  assert.match(sheetCellNote(sparse,89,'current'),/星辰销售明细/);assert.match(sheetCellNote(sparse,90,'current'),/原表加法/);assert.match(sheetCellNote(sparse,94,'current'),/零库存商品/);assert.match(sheetCellNote(sparse,95,'current'),/结算价/);
  assert.equal(sheetValue(sparse,90,'current'),null);assert.equal(sheetValue(sparse,94,'current'),null);
  assert.match(sheetCellNote({...sparse,companyStock:'0'},93,'current'),/内外仓名单/);
  assert.equal(a.companySales,'4');assert.equal(sparse.companySales,'4');
});


test('原明细可单独载入；新批次保留原行和CJ之前全部原值，追加七列并导出金额公式',async()=>{
  const owner='inherit-owner',master=xlsx([Object.fromEntries(defaultKingdeeTemplate.columns.map(c=>[c.key,c.label])),
    {A:'原类目',B:'原型号',C:'POD',D:'原IP',E:'B',F:'原乙',CD:'88',CE:'12',CF:'100',CG:'65',CH:'10',CI:'75',CJ:'6',CK:'9.9341',CL:'745.0575',CM:'59.6046',CN:'804.6621'},
    {A:'另一类',E:'OLD-ONLY',F:'仅原表物料',G:'90'}],'明细');
  saveKingdeeWarehouses(owner,'actor',rules.warehouses.members);
  const base=await createKingdeeImport(owner,'actor',[{kind:'legacy',name:'原明细.xlsx',bytes:master}],undefined,{}, {},{baselineOnly:true});
  const baseline=kingdeeView(owner);assert.equal(baseline.rows.length,2);assert.equal(sheetColumns(base.template!,'current').length,92);
  assert.equal(sheetValue(baseline.rows[0],2,'current',base.template!),null);assert.equal(sheetValue(baseline.rows[0],91,'current',base.template!),'804.6621');
  const period={id:'ignored',start:'2026-10-01',end:'2026-10-31',stockDate:'2026-10-23'};
  const uploads=Object.entries(fixture).map(([kind,bytes])=>({kind:kind as keyof typeof fixture,name:kind+'.xlsx',bytes}));
  const first=await createKingdeeImport(owner,'actor',uploads,undefined,{}, {},{baseBatchId:base.id,period});
  const view=kingdeeView(owner),rows=view.rows,columns=sheetColumns(first.template!,'current');
  assert.equal(columns.length,99);assert.deepEqual(rows.map(r=>[r.code,r.sheetRow]),[['B',2],['OLD-ONLY',3],['A',4]]);
  assert.equal(columns[88].label,'10.1-31公司销量');assert.equal(columns[91].label,'10.23内仓结存');assert.equal(columns[95].label,'结算价');
  for(let i=0;i<88;i++)assert.equal(sheetValue(rows[0],i,'current',first.template!),sheetValue(baseline.rows[0],i,'current',base.template!),`原列${i}`);
  assert.equal(sheetValue(rows[2],90,'current',first.template!),'5');
  assert.equal(kingdeeView(owner,new URLSearchParams({column:'CD',contains:'88'})).rows[0].code,'B');
  const second=await createKingdeeImport(owner,'actor',[],undefined,Object.fromEntries(first.sources.map(s=>[s.kind,first.id])),{}, {baseBatchId:first.id,period:{...period,stockDate:'2026-10-24'}});
  const secondRows=kingdeeExportData(owner,second.id).rows;
  assert.equal(sheetColumns(second.template!,'current').length,106);assert.equal(sheetValue(secondRows[2],90,'current',second.template!),'5');assert.equal(sheetValue(secondRows[2],97,'current',second.template!),'5');
  assert.equal(kingdeeView(owner,new URLSearchParams({column:'CM',contains:'5'})).rows[0].code,'A');
  const recalculated=await createKingdeeImport(owner,'actor',[],second.id);
  assert.equal(sheetColumns(recalculated.template!,'current').length,106);assert.equal(getKingdeeBatch(owner,first.id).template!.periods!.length,1);
  const exported=Buffer.from(kingdeeWorkbook(first,rows));const readback=readKingdeeXlsx(exported,{sheet:'明细'});
  assert.equal(readback.find(r=>r.cells.E==='A')!.cells.CS,'12.5');assert.equal(readback[1].cells.CD,'88');
  writeFileSync(join(root,'inherited.xlsx'),exported);
  const missingMaster=uploads;
  await assert.rejects(createKingdeeImport('no-master','actor',missingMaster,undefined,{}, {},{period}),/原明细底表/);
  await assert.rejects(createKingdeeImport('other-owner','actor',uploads,undefined,{}, {},{baseBatchId:base.id,period}),/找不到/);
});

test('公司库存只排除指定三种编码，销售保留；其他数字编码不误排，空白按原表加法参与销量',async()=>{
  const inputs=files();
  writeFileSync(inputs[0].path,xlsx([{},{},{...headers,C:'出库数量',D:'客户名称'}, {A:'123456',B:'占位商品',C:'5'},{A:'2020040101',B:'占位',C:'7'},{A:'999999',B:'普通数字编码',C:'3'},{A:'合计',C:'15'}]));
  writeFileSync(inputs[1].path,xlsx([{},{},{},{...headers,C:'仓库名称',J:'结存'},{J:'数量'},{A:'123456',B:'占位',C:'内仓',J:'100'},{A:'1234560',B:'仅库存占位',C:'内仓',J:'200'},{A:'2020040101',B:'占位',C:'外仓',J:'300'},{A:'999999',B:'普通',C:'内仓',J:'10'},{A:'合计',J:'610'}]));
  const report=await importKingdeeFiles(inputs,rules),by=new Map(report.rows.map(r=>[r.code,r]));
  assert.equal(by.get('123456')!.companySales,'5');assert.equal(by.get('123456')!.combinedSales,'5');assert.equal(by.get('123456')!.companyStock,null);
  assert.equal(by.has('1234560'),false);assert.equal(by.get('999999')!.companyStock,'10');assert.equal(report.summary.totals.companyStock,'10');
  assert.equal(report.sources.find(s=>s.kind==='companyStock')!.total,'610');assert.match(report.summary.notices.join(''),/共3行/);
});
