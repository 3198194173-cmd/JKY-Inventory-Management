import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable("sync_runs", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  status: text("status").notNull(),
  startedAt: text("started_at").notNull(),
  lastProgressAt: text("last_progress_at").notNull().default(""),
  completedAt: text("completed_at"),
  pageCount: integer("page_count").notNull().default(0),
  recordCount: integer("record_count").notNull().default(0),
  goodsCount: integer("goods_count").notNull().default(0),
  message: text("message"),
  warehouseCode: text("warehouse_code").notNull().default("CK031"),
  trigger: text("trigger").notNull().default("manual"),
}, t => [index("idx_runs_owner_time").on(t.owner, t.startedAt),index("idx_runs_warehouse_time").on(t.owner,t.warehouseCode,t.startedAt)]);

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
  unavailableSkus: text("unavailable_skus").notNull().default("[]"),
}, t => [index("idx_snapshots_owner_date").on(t.owner, t.status, t.date, t.capturedAt),index("idx_snapshots_warehouse_latest").on(t.owner,t.warehouseCode,t.coverage,t.status,t.capturedAt,t.id)]);

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
  turnoverAverageThreshold: text("turnover_average_threshold").notNull().default("3"),
  lastDigest: text("last_digest"),
  lastSentAt: text("last_sent_at"),
  lastResult: text("last_result"),
});

export const turnoverAlertDeliveries = sqliteTable("turnover_alert_deliveries", {
  owner: text("owner").notNull(),
  warehouseCode: text("warehouse_code").notNull(),
  date: text("date").notNull(),
  snapshotId: text("snapshot_id").notNull(),
  averageThreshold: text("average_threshold").notNull(),
  matchingCount: integer("matching_count").notNull(),
  state: text("state").notNull(),
  attemptedAt: text("attempted_at").notNull(),
  acceptedAt: text("accepted_at"),
}, t=>[primaryKey({columns:[t.owner,t.warehouseCode,t.date]})]);

export const dingTalkGroups = sqliteTable("dingtalk_groups", {
  owner: text("owner").notNull(),
  clientId: text("client_id").notNull(),
  robotCode: text("robot_code").notNull(),
  openConversationId: text("open_conversation_id").notNull(),
  name: text("name").notNull().default(""),
  enabled: integer("enabled").notNull().default(0),
  active: integer("active").notNull().default(1),
  lastSeenAt: text("last_seen_at").notNull(),
  nameCheckedAt: text("name_checked_at"),
}, t=>[primaryKey({columns:[t.owner,t.clientId,t.robotCode,t.openConversationId]})]);

export const dingTalkGroupSync = sqliteTable("dingtalk_group_sync", {
  owner: text("owner").notNull(),
  clientId: text("client_id").notNull(),
  robotCode: text("robot_code").notNull(),
  lastAttemptAt: text("last_attempt_at"),
  lastSyncedAt: text("last_synced_at"),
  error: text("error"),
  lease: text("lease"),
  leaseUntil: integer("lease_until").notNull().default(0),
}, t=>[primaryKey({columns:[t.owner,t.clientId,t.robotCode]})]);

export const turnoverGroupDeliveries = sqliteTable("turnover_group_deliveries", {
  owner: text("owner").notNull(),
  clientId: text("client_id").notNull(),
  robotCode: text("robot_code").notNull(),
  openConversationId: text("open_conversation_id").notNull(),
  warehouseCode: text("warehouse_code").notNull(),
  date: text("date").notNull(),
  snapshotId: text("snapshot_id").notNull(),
  averageThreshold: text("average_threshold").notNull(),
  matchingCount: integer("matching_count").notNull(),
  state: text("state").notNull(),
  attemptedAt: text("attempted_at").notNull(),
  acceptedAt: text("accepted_at"),
}, t=>[primaryKey({columns:[t.owner,t.clientId,t.robotCode,t.openConversationId,t.warehouseCode,t.date]})]);

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

export const inboundReconciliations = sqliteTable("inbound_reconciliations", {
  queryScope: text("query_scope").notNull().default("goods:v1"),
  owner: text("owner").notNull(),
  warehouseCode: text("warehouse_code").notNull(),
  goodsNo: text("goods_no").notNull(),
  date: text("date").notNull(),
  beforeSnapshotId: text("before_snapshot_id").notNull().references(() => snapshots.id),
  afterSnapshotId: text("after_snapshot_id").notNull().references(() => snapshots.id),
  unitName: text("unit_name").notNull(),
  rawDifference: text("raw_difference").notNull(),
  openingQuantity: text("opening_quantity").notNull(),
  closingQuantity: text("closing_quantity").notNull(),
  status: text("status").notNull(),
  inboundQuantity: text("inbound_quantity"),
  correctedQuantity: text("corrected_quantity"),
  windowStart: text("window_start").notNull(),
  windowEnd: text("window_end").notNull(),
  records: text("records").notNull().default("[]"),
  error: text("error"),
  checkedAt: text("checked_at").notNull(),
}, t => [primaryKey({ columns: [t.owner,t.warehouseCode,t.goodsNo,t.beforeSnapshotId,t.afterSnapshotId] }),index("idx_inbound_owner_warehouse_date").on(t.owner,t.warehouseCode,t.date)]);
