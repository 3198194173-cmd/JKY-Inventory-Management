import type { ScopeInfo } from "./stock-scope";
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
};

export type InventoryView = {
  warehouseCode: string;
  warehouseName: string;
  source: "live" | "sample";
  snapshot: SnapshotInfo | null;
  snapshots: SnapshotInfo[];
  rows: (StockRow & { history: Record<string, string | null> })[];
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
  completedAt: string | null;
  pageCount: number;
  recordCount: number;
  goodsCount: number;
  message: string | null;
};
