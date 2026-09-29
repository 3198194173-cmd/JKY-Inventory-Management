import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable("sync_runs", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  status: text("status").notNull(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  pageCount: integer("page_count").notNull().default(0),
  recordCount: integer("record_count").notNull().default(0),
  goodsCount: integer("goods_count").notNull().default(0),
  message: text("message"),
  warehouseCode: text("warehouse_code").notNull().default("CK031"),
  trigger: text("trigger").notNull().default("manual"),
}, t => [index("idx_runs_owner_time").on(t.owner, t.startedAt)]);

export const snapshots = sqliteTable("stock_snapshots", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  date: text("date").notNull(),
  capturedAt: text("captured_at").notNull(),
  status: text("status").notNull(),
  pageCount: integer("page_count").notNull(),
  recordCount: integer("record_count").notNull(),
  goodsCount: integer("goods_count").notNull(),
  totals: text("totals").notNull(),
  zeroCount: integer("zero_count").notNull(),
  negativeCount: integer("negative_count").notNull(),
  scopeKey: text("scope_key").notNull().default(""),
  scopeLabel: text("scope_label").notNull().default("范围未确认"),
  scopeCount: integer("scope_count").notNull().default(0),
  warehouseCode: text("warehouse_code").notNull().default("CK031"),
  warehouseName: text("warehouse_name").notNull().default("易速菲泰国8仓成品仓"),
  coverage: text("coverage").notNull().default("legacy-partial"),
  catalogHash: text("catalog_hash").notNull().default(""),
}, t => [index("idx_snapshots_owner_date").on(t.owner, t.status, t.date, t.capturedAt)]);

export const entries = sqliteTable("stock_entries", {
  snapshotId: text("snapshot_id").notNull().references(() => snapshots.id),
  goodsNo: text("goods_no").notNull(),
  goodsName: text("goods_name").notNull(),
  unitName: text("unit_name").notNull(),
  quantity: text("quantity").notNull(),
  skuCount: integer("sku_count").notNull(),
  sign: integer("sign").notNull(),
}, t => [primaryKey({ columns: [t.snapshotId, t.goodsNo] })]);

export const alertSettings = sqliteTable("alert_settings", {
  owner: text("owner").primaryKey(),
  enabled: integer("enabled").notNull().default(0),
  threshold: text("threshold").notNull().default("0"),
  lastDigest: text("last_digest"),
  lastSentAt: text("last_sent_at"),
  lastResult: text("last_result"),
});

export const stockScopes = sqliteTable("stock_scopes", {
  owner: text("owner").primaryKey(),
  barcodes: text("barcodes").notNull(),
  label: text("label").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const warehouses = sqliteTable("warehouses", {
  owner: text("owner").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  warehouseId: text("warehouse_id"),
  scheduleEnabled: integer("schedule_enabled").notNull().default(1),
  dailyTime: text("daily_time").notNull().default("08:00"),
  timeZone: text("time_zone").notNull().default("Asia/Shanghai"),
  createdAt: text("created_at").notNull(),
}, t => [primaryKey({ columns: [t.owner, t.code] })]);

export const dailySlots = sqliteTable("daily_slots", {
  owner: text("owner").notNull(),
  warehouseCode: text("warehouse_code").notNull(),
  date: text("date").notNull(),
  snapshotId: text("snapshot_id").notNull().references(() => snapshots.id),
}, t => [primaryKey({ columns: [t.owner, t.warehouseCode, t.date] })]);
