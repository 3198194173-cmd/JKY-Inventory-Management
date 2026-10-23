import preset from '@/data/kingdee-template.json';
import type { KingdeeGoods, KingdeeTemplate, KingdeePeriod } from './kingdee-types';

export type SheetMode = 'current' | 'original';
export const defaultKingdeeTemplate = preset as KingdeeTemplate;
export const currentFields = ['companySales', 'storeSales', 'combinedSales', 'inner', 'outer', 'companyStock', 'storeStock', 'price', 'companyAmount', 'storeAmount', 'totalAmount'] as const;
const headings = ['公司销量', '门店销量', '销量', '内仓结存', '外仓结存', '公司结存', '门店结存', '结算价', '公司结存金额', '门店结存金额', '总金额'];
const unknownPeriod: KingdeePeriod = { id: 'undated', start: '', end: '', stockDate: '' };
export function sheetPeriods(template: KingdeeTemplate) { return template.periods ?? [unknownPeriod]; }
export function currentStart(template: KingdeeTemplate) { return 88 + Math.max(0, sheetPeriods(template).length - 1) * 7; }
export function columnKey(index: number): string { return index < 26 ? String.fromCharCode(65 + index) : columnKey(Math.floor(index / 26) - 1) + String.fromCharCode(65 + index % 26); }
const shortDate = (value: string) => value ? `${Number(value.slice(5,7))}.${Number(value.slice(8,10))}` : '';
export function periodHeading(period: KingdeePeriod, index: number) {
  const range = period.start && period.end ? shortDate(period.start) + '-' + (period.start.slice(0,7) === period.end.slice(0,7) ? Number(period.end.slice(8,10)) : shortDate(period.end)) : '期间待确认';
  return (index < 3 ? range : shortDate(period.stockDate) || '时点待确认') + headings[index];
}
export function sheetColumns(template: KingdeeTemplate, mode: SheetMode) {
  const periods = sheetPeriods(template);
  const columns = mode === 'original' || !periods.length ? template.columns : [...template.columns.slice(0,88), ...periods.flatMap(period => headings.slice(0,7).map((_,i) => ({...template.columns[81+i],label:periodHeading(period,i)}))), ...template.columns.slice(88)];
  return columns.map((c,i)=>({...c,key:columnKey(i),label:i===2?'停止采购':c.label}));
}
// Maps an on-screen column back to an original column or one inserted period field.
export function sheetBinding(index: number, mode: SheetMode, template: KingdeeTemplate = defaultKingdeeTemplate) {
  // All views, including old batches and baseline-only imports, use the JKY attribute.
  if (index === 2) return { field: 'stopPurchasing' as const };
  const periods = sheetPeriods(template);
  if (mode === 'original' || !periods.length) return { original: index };
  if (index < 88) return { original: index };
  const offset = index - 88;
  if (offset < periods.length * 7) {
    const p = Math.floor(offset / 7), f = offset % 7;
    return p === periods.length - 1 ? { field: currentFields[f], style:81+f } : { period: periods[p].id, offset:f, style:81+f };
  }
  const f = 7 + offset - periods.length * 7;
  return { field: currentFields[f], style:81+f };
}
export function sheetValue(row: KingdeeGoods, index: number, mode: SheetMode, template: KingdeeTemplate = defaultKingdeeTemplate): string | null {
  const b = sheetBinding(index,mode,template);
  if (b.field === 'stopPurchasing') return row.stopPurchasing === '是' || row.stopPurchasing === '否' ? row.stopPurchasing : null;
  if (b.field) return row[b.field] ?? null;
  if (b.period) return row.periodValues?.[b.period]?.[b.offset!] ?? null;
  const i = b.original!;
  if (row.legacy) return row.legacy.values[i] ?? null;
  return i < 6 ? row[(['category','model','pod','ip','code','name'] as const)[i]] : null;
}
export function sheetStyleIndex(row: KingdeeGoods, index: number, template: KingdeeTemplate, mode: SheetMode) {
  const b = sheetBinding(index,mode,template), original = b.original ?? b.style ?? 2;
  return row.legacy?.styles[original] ?? template.columns[original].bodyStyle;
}
export function sheetStyle(row: KingdeeGoods, index: number, template: KingdeeTemplate, mode: SheetMode) {
  return template.styles[sheetStyleIndex(row,index,template,mode)] || template.styles[0];
}
export function sheetCellNote(row: KingdeeGoods,index: number,mode: SheetMode, template: KingdeeTemplate = defaultKingdeeTemplate): string {
  const binding=sheetBinding(index,mode,template);
  if(binding.period)return '已保存的历史批次值，按当时来源和规则计算。';
  if(binding.original!==undefined&&binding.original>=6)return '原Excel历史值，完整保留，不按本批来源覆盖。';
  if(binding.field&&binding.field!=='stopPurchasing')index=81+currentFields.indexOf(binding.field);
  if(index===2&&binding.field==='stopPurchasing')return row.purchaseStatus==='ready'?'吉客云本批货品查询isStopPurchasing：停止采购为是，正常采购为否。':row.purchaseStatus==='conflict'?'同编码多条规格停止采购值冲突或缺失，留空待核验。':'本批吉客云来源未覆盖该编码，停止采购未知，留空等待采集。';
  if(mode==='original')return '原表历史缓存值，未按本批数据改写。';
  if(index<4)return row.legacy?'沿用旧明细主档；原表空白仍保留。':'该物料未匹配旧明细/四维主档，未从名称或其他分类字段猜测映射。';
  if(index>=6&&index<81)return row.legacy?'原表历史缓存值。':'未提供该物料的旧明细历史数据，当前四份业务报表不能补出历史月份。';
  if(index===81)return row.companySales===null?(row.sources.companySales?.length?'该物料的公司销量业务行被客户排除规则排除，未按0填充。':'星空公司销量来源没有该物料记录，未按0填充。'):'独立汇总星空出库数量，保留赠品和负数。';
  if(index===82)return row.storeSales===null?'星辰销售明细没有该物料记录，未按0填充。':'独立汇总星辰销售基本数量，保留负数。';
  if(index===83)return row.combinedSales===null?'销量按原表加法公式计算，来源没有该编码的空白按0参与相加；完整来源缺失时不允许生成。':'公司销量＋门店销量，按物料编码关联。';
  if(index>=84&&index<=86&&row.inventoryExcluded)return '该物料编码按公司库存排除规则排除，销量仍正常统计。';
  if(index>=84&&index<=86)return row.companyStock===null?'星空库存来源没有该物料记录，结存未知。':'只统计当前内外仓名单，其他仓库不计入；0是名单范围的计算结果。';
  if(index===87)return row.storeStock===null?'星辰库存来源没有该物料记录；该导出可能未包含零库存商品，不能据此确认库存为0。':'星辰库存独立汇总，不会因星空日期不同而丢弃。';
  if(index===88)return row.price===null?(row.priceStatus==='conflict'?'结算价候选冲突，未选取任意价格。':'价目表没有符合条件的结算价，未按0计算。'):'来自销售价目表，不使用库存参考价。';
  if(index===89&&row.companyAmount===null)return '公司结存或结算价缺失，未计算公司结存金额。';
  if(index===90&&row.storeAmount===null)return '门店结存或结算价缺失，未计算门店结存金额。';
  if(index===91&&row.totalAmount===null)return '结算价缺失时金额留空；有价格时按原表数量乘价、金额相加公式计算。';
  return '';
}
export function sheetDataPath(index: number, mode: SheetMode, template: KingdeeTemplate = defaultKingdeeTemplate) {
  const b = sheetBinding(index,mode,template);
  if (b.field) return '$.' + b.field;
  if (b.period) return `$.periodValues."${b.period}"[${b.offset}]`;
  return `$.legacy.values[${b.original}]`;
}
