import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { addQuantity, multiplyQuantity, normalizeQuantity } from './decimal';
import { readKingdeeWorkbook, type XlsxRow } from './kingdee-xlsx';
import { sourceKinds, sourceLabels, type KingdeeGoods, type KingdeeReport, type KingdeeRules, type KingdeeTemplate, type SourceKind, type SourceMeta } from './kingdee-types';

export type ImportFile = { kind: SourceKind; path: string; name: string };
const total = (values: Iterable<string>) => [...values].reduce((sum, value) => addQuantity(sum, value), '0');
function add(map: Map<string, string>, code: string, value: string) { map.set(code, addQuantity(map.get(code) || '0', value)); }
function quantity(value: string | undefined, blankZero = false) {
  if ((value === undefined || value === '') && blankZero) return '0';
  return normalizeQuantity(value);
}

export async function importKingdeeFiles(files: ImportFile[], rules: KingdeeRules): Promise<KingdeeReport> {
  const names = new Map<string, string>();
  const products = new Map<string, Partial<KingdeeGoods>>();
  const companySales = new Map<string, string>(), storeSales = new Map<string, string>();
  const inner = new Map<string, string>(), outer = new Map<string, string>(), storeStock = new Map<string, string>();
  const companyStockCodes = new Set<string>();
  const priceCandidates = new Map<string, { value: string | null; signature: string; rows: number[] }>();
  const warehouses = new Map<string, { quantity: string; rows: number; group: string }>();
  const assignments = new Map(rules.warehouses.members.map(member => [member.name, member.group]));
  const sources: SourceMeta[] = [], notices: string[] = [];
  let excludedSales = 0, rejectedPrices = 0;
  let template: KingdeeTemplate | undefined;
  function goods(code: string, name: string, kind: SourceKind, row: number) {
    if (!code || code === '合计') return;
    if (!names.has(code)) names.set(code, name);
    const item = products.get(code) || { sources: {} };
    const refs = item.sources![kind] ||= [];
    if (refs.length < 100) refs.push(row); // Raw files retain the complete source rows.
    products.set(code, item);
  }

  for (const kind of sourceKinds) {
    const file = files.find(item => item.kind === kind);
    if (!file) { if (kind === 'legacy') continue; throw new Error('缺少来源：' + sourceLabels[kind]); }
    const bytes = await readFile(file.path);
    let rows: XlsxRow[];
    try { const parsed = readKingdeeWorkbook(bytes, kind === 'legacy' ? { sheet: '明细', formatting: true } : {}); rows = parsed.rows; if (kind === 'legacy') template = parsed.template; }
    catch (error) { throw new Error(sourceLabels[kind] + '：' + (error instanceof Error ? error.message : '解析失败')); }
    const headerRow = kind === 'legacy' || kind === 'prices' ? 1 : kind === 'companyStock' ? 4 : 3;
    const header = rows.find(item => item.row === headerRow)?.cells;
    if (!header) throw new Error(sourceLabels[kind] + '缺少表头');
    const byName = Object.fromEntries(Object.entries(header).map(([column, label]) => [label.trim(), column]));
    const field = (row: XlsxRow, label: string) => row.cells[byName[label]]?.trim() || '';
    const required: Record<SourceKind, string[]> = {
      legacy: ['类目', '型号', '物料编码', '物料名称'],
      companySales: ['物料编码', '物料名称', '出库数量', '客户名称'],
      companyStock: ['物料编码', '物料名称', '仓库名称', '结存'],
      storeSales: ['商品编码', '商品名称', '基本数量'],
      storeStock: ['商品编码', '商品名称', '即时库存（基本）'],
      prices: ['物料编码', '价格', '编号', ...Object.keys(rules.settlementPrice.requiredProfile)],
    };
    if (required[kind].some(label => Object.values(header).filter(value => value.trim() === label).length !== 1)) throw new Error(sourceLabels[kind] + '表头不匹配或重复，请检查文件类型');
    const codeColumn = kind === 'legacy' ? 'E' : kind === 'companyStock' ? 'A' : byName[kind === 'storeSales' || kind === 'storeStock' ? '商品编码' : '物料编码'];
    const firstData = kind === 'companyStock' ? 5 : headerRow;
    const data = rows.filter(row => row.row > firstData && row.cells[codeColumn]?.trim() && !Object.values(row.cells).includes('合计'));
    const qtyColumn = kind === 'companyStock' ? 'J' : byName[{ companySales: '出库数量', storeSales: '基本数量', storeStock: '即时库存（基本）' }[kind as 'companySales']];
    let checkedTotal: string | null = null;
    if (qtyColumn) {
      const totals = rows.filter(row => Object.values(row.cells).includes('合计'));
      if (totals.length !== 1) throw new Error(sourceLabels[kind] + '缺少唯一合计行');
      checkedTotal = total(data.map(row => quantity(row.cells[qtyColumn], true)));
      if (checkedTotal !== quantity(totals[0].cells[qtyColumn])) throw new Error(sourceLabels[kind] + '逐行加总与源合计不一致');
    }
    sources.push({ kind, name: file.name, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, rows: data.length,
      conditions: rows.filter(row => row.row < headerRow).map(row => Object.values(row.cells).join(' ')).join('；').slice(0, 3000), total: checkedTotal });

    for (const row of data) {
      const code = row.cells[codeColumn].trim();
      if (kind === 'prices') {
        if (Object.entries(rules.settlementPrice.requiredProfile).some(([key, value]) => field(row, key) !== value)) { rejectedPrices++; continue; }
        let value: string | null = null;
        try { value = quantity(field(row, '价格')); } catch { /* Missing prices stay missing. */ }
        const signature = JSON.stringify([value, field(row, '编号')]);
        const existing = priceCandidates.get(code);
        if (!existing) priceCandidates.set(code, { value, signature, rows: [row.row] });
        else { if (existing.signature !== signature || value === null) { existing.value = null; existing.signature = 'conflict'; } existing.rows.push(row.row); }
        continue;
      }
      goods(code, kind === 'legacy' ? row.cells.F || '' : field(row, kind === 'storeStock' || kind === 'storeSales' ? '商品名称' : '物料名称'), kind, row.row);
      const product = products.get(code)!;
      if (kind === 'legacy') {
        if (product.legacy) throw new Error('旧明细物料编码重复，不能覆盖历史行：' + code);
        if (template) product.legacy = { row: row.row, values: template.columns.map(column => row.cells[column.key] ?? null), styles: template.columns.map(column => row.styles?.[column.key] ?? column.bodyStyle) };
        names.set(code, row.cells.F || names.get(code) || '');
        Object.assign(product, { category: row.cells.A || null, model: row.cells.B === '0' ? null : row.cells.B || null,
          pod: row.cells.C || null, ip: row.cells.D === '0' ? null : row.cells.D || null });
      } else if (kind === 'companySales') {
        if (rules.companySales.excludeCustomerContains.some(name => field(row, '客户名称').toLowerCase().includes(name.toLowerCase()))) { excludedSales++; continue; }
        add(companySales, code, quantity(row.cells[qtyColumn], true));
      } else if (kind === 'companyStock') {
        const name = field(row, '仓库名称'), group = assignments.get(name) || 'outside', amount = quantity(row.cells.J, true);
        const item = warehouses.get(name) || { quantity: '0', rows: 0, group };
        item.quantity = addQuantity(item.quantity, amount); item.rows++; warehouses.set(name, item);
        companyStockCodes.add(code);
        if (group === 'inner') add(inner, code, amount);
        if (group === 'outer') add(outer, code, amount);
      } else if (kind === 'storeSales') add(storeSales, code, quantity(row.cells[qtyColumn], true));
      else if (kind === 'storeStock') add(storeStock, code, quantity(row.cells[qtyColumn], true));
    }
  }
  let nextSheetRow = [...products.values()].reduce((max, row) => Math.max(max, row.legacy?.row || 0), 1) + 1;
  const result: KingdeeGoods[] = [...names].sort(([a], [b]) => (products.get(a)?.legacy?.row ?? Number.MAX_SAFE_INTEGER) - (products.get(b)?.legacy?.row ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b, 'en')).map(([code, name]) => {
    const product = products.get(code)!, priceItem = priceCandidates.get(code);
    const priceStatus = priceItem?.signature === 'conflict' ? 'conflict' : priceItem?.value != null ? 'ready' : 'missing';
    const price = priceStatus === 'ready' ? priceItem!.value : null;
    const hasStock = companyStockCodes.has(code), i = hasStock ? inner.get(code) || '0' : null, o = hasStock ? outer.get(code) || '0' : null;
    const stock = i !== null && o !== null ? addQuantity(i, o) : null, store = storeStock.get(code) ?? null;
    const cSales = companySales.get(code) ?? null, sSales = storeSales.get(code) ?? null;
    const companyAmount = stock !== null && price !== null ? multiplyQuantity(stock, price) : null;
    const storeAmount = store !== null && price !== null ? multiplyQuantity(store, price) : null;
    if (priceItem) product.sources!.prices = priceItem.rows.slice(0, 100);
    return { code, name, category: product.category ?? null, model: product.model ?? null, pod: product.pod ?? null, ip: product.ip ?? null,
      companySales: cSales, storeSales: sSales, combinedSales: cSales !== null && sSales !== null ? addQuantity(cSales, sSales) : null,
      inner: i, outer: o, companyStock: stock, storeStock: store, price, priceStatus, companyAmount, storeAmount,
      totalAmount: companyAmount !== null && storeAmount !== null ? addQuantity(companyAmount, storeAmount) : null, sources: product.sources!, sheetRow: product.legacy?.row ?? nextSheetRow++, ...(product.legacy ? { legacy: product.legacy } : {}) };
  });
  notices.push('按原明细A—CN共92列展示。历史G—CC保留原表缓存值，年份暂不推断；CD—CN为本批销量、结存、价格和金额，不覆盖原表历史时点。');
  notices.push('原表对照保留原92列表头与缓存值；销量期间、库存时点、退货口径、价格单位/有效期及新商品分类仍暂缓核验。');
  notices.push('公司库存仅统计当前名单内仓库；门店库存按导出值汇总。合计销量和金额仅作当前来源的参考。');
  notices.push('空白表示当前来源未覆盖或资料待补；缺价不按0计算，金额合计仅含可计算部分。');
  if (excludedSales) notices.push(`公司销售按既有客户规则排除${excludedSales}行，不按赠品标记筛选。`);
  if (rejectedPrices) notices.push(`价目表有${rejectedPrices}行不符合组织/币别/含税/状态范围，未用于定价。`);
  const outside = [...warehouses].filter(([, value]) => value.group === 'outside');
  if (outside.length) notices.push(`${outside.length}个来源仓库未纳入当前名单，可在仓库分组中调整后重新导入。`);
  const unmatched = rules.warehouses.members.filter(member => member.group !== 'excluded' && !warehouses.has(member.name)).map(member => member.name);
  if (unmatched.length) notices.push(`名单中${unmatched.length}个仓库未出现在本批导出，覆盖范围仍待核对。`);
  return { rows: result, rules, sources, ...(template ? { template } : {}), summary: {
    goods: result.length, priced: result.filter(row => row.priceStatus === 'ready').length,
    missingPrices: result.filter(row => row.priceStatus === 'missing').length, conflictingPrices: result.filter(row => row.priceStatus === 'conflict').length,
    pendingClassifications: result.filter(row => [row.category, row.model, row.pod, row.ip].some(value => value === null)).length,
    totals: { companySales: total(companySales.values()), storeSales: total(storeSales.values()), inner: total(inner.values()), outer: total(outer.values()),
      companyStock: addQuantity(total(inner.values()), total(outer.values())), storeStock: total(storeStock.values()),
      knownCompanyAmount: total(result.flatMap(row => row.companyAmount === null ? [] : [row.companyAmount])),
      knownStoreAmount: total(result.flatMap(row => row.storeAmount === null ? [] : [row.storeAmount])) },
    warehouses: [...warehouses].map(([name, value]) => ({ name, ...value })), unmatchedConfiguredWarehouses: unmatched, notices,
  } };
}
