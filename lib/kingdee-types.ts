export const sourceKinds = ['companySales', 'companyStock', 'storeSales', 'storeStock', 'prices', 'legacy'] as const;
export type SourceKind = typeof sourceKinds[number];
export const sourceLabels: Record<SourceKind, string> = {
  companySales: '星空销售出库汇总', companyStock: '星空物料收发汇总',
  storeSales: '星辰销售明细', storeStock: '星辰库存查询', prices: '销售价目表', legacy: '旧明细主档（可选）',
};
export type WarehouseMember = { name: string; group: 'inner' | 'outer' | 'excluded' };
export type KingdeeRules = {
  version: number; confirmedOn: string;
  companySales: { excludeCustomerContains: string[] };
  warehouses: { members: WarehouseMember[]; scopeMode: string; membershipConfirmed: boolean };
  settlementPrice: { requiredProfile: Record<string, string> };
};
export type SourceMeta = { kind: SourceKind; name: string; sha256: string; size: number; rows: number; conditions: string; total: string | null; originBatchId?: string; originCollectionId?: string };
export type SourceReferences = Partial<Record<SourceKind, string>>;
export type ExcelCellStyle = { background: string; color: string; font: string; size: number; bold: boolean; italic: boolean; strike: boolean; align: string; format: string };
export type KingdeeTemplate = {
  columns: { key: string; label: string; width: number; headerStyle: number; bodyStyle: number }[];
  styles: ExcelCellStyle[]; frozenColumns: number; frozenRows: number; rowHeight: number; headerHeight: number;
};
export type KingdeeGoods = {
  code: string; name: string; category: string | null; model: string | null; pod: string | null; ip: string | null;
  companySales: string | null; storeSales: string | null; combinedSales: string | null;
  inner: string | null; outer: string | null; companyStock: string | null; storeStock: string | null;
  price: string | null; priceStatus: 'ready' | 'missing' | 'conflict';
  companyAmount: string | null; storeAmount: string | null; totalAmount: string | null;
  sources: Partial<Record<SourceKind, number[]>>;
  sheetRow?: number;
  legacy?: { row: number; values: (string | null)[]; styles: number[] };
};
export type KingdeeSummary = {
  goods: number; priced: number; missingPrices: number; conflictingPrices: number; pendingClassifications: number;
  totals: { companySales: string; storeSales: string; inner: string; outer: string; companyStock: string; storeStock: string; knownCompanyAmount: string; knownStoreAmount: string };
  warehouses: { name: string; quantity: string; rows: number; group: string }[];
  unmatchedConfiguredWarehouses: string[]; notices: string[];
};
export type KingdeeReport = { rows: KingdeeGoods[]; summary: KingdeeSummary; sources: SourceMeta[]; rules: KingdeeRules; template?: KingdeeTemplate };
export type KingdeeBatch = { id: string; createdAt: string; state: string; error: string; summary: KingdeeSummary; sources: SourceMeta[]; rules: KingdeeRules; template?: KingdeeTemplate };
