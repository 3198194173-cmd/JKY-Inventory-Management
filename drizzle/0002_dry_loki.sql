CREATE TABLE `daily_slots` (
	`owner` text NOT NULL,
	`warehouse_code` text NOT NULL,
	`date` text NOT NULL,
	`snapshot_id` text NOT NULL,
	PRIMARY KEY(`owner`, `warehouse_code`, `date`),
	FOREIGN KEY (`snapshot_id`) REFERENCES `stock_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `warehouses` (
	`owner` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`warehouse_id` text,
	`schedule_enabled` integer DEFAULT 1 NOT NULL,
	`daily_time` text DEFAULT '08:00' NOT NULL,
	`time_zone` text DEFAULT 'Asia/Shanghai' NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner`, `code`)
);
--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `warehouse_code` text DEFAULT 'CK031' NOT NULL;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `trigger` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `stock_snapshots` ADD `warehouse_code` text DEFAULT 'CK031' NOT NULL;--> statement-breakpoint
ALTER TABLE `stock_snapshots` ADD `warehouse_name` text DEFAULT '易速菲泰国8仓成品仓' NOT NULL;--> statement-breakpoint
ALTER TABLE `stock_snapshots` ADD `coverage` text DEFAULT 'legacy-partial' NOT NULL;--> statement-breakpoint
ALTER TABLE `stock_snapshots` ADD `catalog_hash` text DEFAULT '' NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO warehouses (owner, code, name, warehouse_id, created_at) SELECT owner, 'CK031', '易速菲泰国8仓成品仓', '2391620541187785472', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM (SELECT owner FROM stock_snapshots UNION SELECT owner FROM sync_runs);
