import preset from '@/data/kingdee-template.json';
import type { KingdeeGoods, KingdeeTemplate } from './kingdee-types';

export type SheetMode = 'current' | 'original';
export const defaultKingdeeTemplate = preset as KingdeeTemplate;
export const currentFields = ['companySales', 'storeSales', 'combinedSales', 'inner', 'outer', 'companyStock', 'storeStock', 'price', 'companyAmount', 'storeAmount', 'totalAmount'] as const;
const headings = ['本批公司销量', '本批门店销量', '本批销量', '本批内仓结存', '本批外仓结存', '本批公司结存', '本批门店结存', '结算价', '公司结存金额', '门店结存金额', '总金额'];
export function sheetColumns(template: KingdeeTemplate, mode: SheetMode) {
  return template.columns.map((column, index) => ({ ...column, label: mode === 'current' && index >= 81 ? headings[index - 81] : column.label }));
}
export function sheetValue(row: KingdeeGoods, index: number, mode: SheetMode): string | null {
  if (mode === 'original') return row.legacy?.values[index] ?? null;
  if (index >= 81) return row[currentFields[index - 81]];
  if (row.legacy) return row.legacy.values[index] ?? null;
  return index < 6 ? row[(['category', 'model', 'pod', 'ip', 'code', 'name'] as const)[index]] : null;
}
export function sheetStyle(row: KingdeeGoods, index: number, template: KingdeeTemplate, mode: SheetMode) {
  const column = template.columns[index];
  // Historical cells keep their source formats; current fields retain the template's column colours.
  const style = mode === 'original' || index < 81 ? row.legacy?.styles[index] ?? column.bodyStyle : column.headerStyle;
  return template.styles[style] || template.styles[column.bodyStyle];
}
export function sheetDataPath(index: number, mode: SheetMode) {
  if (mode === 'original' || (index >= 6 && index < 81)) return `$.legacy.values[${index}]`;
  if (index >= 81) return '$.' + currentFields[index - 81];
  return '$.' + ['category', 'model', 'pod', 'ip', 'code', 'name'][index];
}
