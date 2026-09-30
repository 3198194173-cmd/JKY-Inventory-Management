import type { ScopeInfo } from "./stock-scope";
export type WarehouseInfo = { code: string; name: string; warehouseId: string | null; dailyTime: string; timeZone: string };
export type UnavailableSku = { skuId: string; goodsNo: string; goodsName: string; skuName: string; skuBarcode: string; unitName: string; reason: string };
export type StockRow = {
  goodsNo: string;
  goodsName: string;
  unitName: string;
  quantity: string;
  skuCount: number;
};

export type SnapshotInfo = {
  id: string;
  capturedAt: string;
  date: string;
  source: "live" | "sample";
  pageCount: number;
  recordCount: number;
  scope: ScopeInfo | null;
  unavailableSkus?: UnavailableSku[];
};

export type InventoryView = {
  warehouseCode: string;
  warehouseName: string;
  source: "live" | "sample";
  snapshot: SnapshotInfo | null;
  snapshots: SnapshotInfo[];
  rows: (StockRow & { history: Record<string, string | null>; sales?: Record<string, string | null> })[];
  warehouses?: WarehouseInfo[];
  salesDates?: string[];
  scheduleActive?: boolean;
  dailyTime?: string;
  unavailableSkus?: UnavailableSku[];
  configured: boolean;
  robotConfigured: boolean;
  totalRows: number;
  goodsCount: number;
  page: number;
  pageSize: number;
  totalsByUnit: Record<string, string>;
  zeroCount: number;
  negativeCount: number;
};

export type RunInfo = {
  id: string;
  status: string;
  startedAt: string;
  lastProgressAt?: string;
  completedAt: string | null;
  pageCount: number;
  recordCount: number;
  goodsCount: number;
  message: string | null;
  warehouseCode?: string;
};
