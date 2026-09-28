CREATE TABLE `alert_settings` (
	`owner` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`threshold` text DEFAULT '0' NOT NULL,
	`last_digest` text,
	`last_sent_at` text,
	`last_result` text
);
--> statement-breakpoint
CREATE TABLE `stock_entries` (
	`snapshot_id` text NOT NULL,
	`goods_no` text NOT NULL,
	`goods_name` text NOT NULL,
	`unit_name` text NOT NULL,
	`quantity` text NOT NULL,
	`sku_count` integer NOT NULL,
	`sign` integer NOT NULL,
	PRIMARY KEY(`snapshot_id`, `goods_no`),
	FOREIGN KEY (`snapshot_id`) REFERENCES `stock_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`page_count` integer DEFAULT 0 NOT NULL,
	`record_count` integer DEFAULT 0 NOT NULL,
	`goods_count` integer DEFAULT 0 NOT NULL,
	`message` text
);
--> statement-breakpoint
CREATE INDEX `idx_runs_owner_time` ON `sync_runs` (`owner`,`started_at`);--> statement-breakpoint
CREATE TABLE `stock_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`date` text NOT NULL,
	`captured_at` text NOT NULL,
	`status` text NOT NULL,
	`page_count` integer NOT NULL,
	`record_count` integer NOT NULL,
	`goods_count` integer NOT NULL,
	`totals` text NOT NULL,
	`zero_count` integer NOT NULL,
	`negative_count` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_snapshots_owner_date` ON `stock_snapshots` (`owner`,`status`,`date`,`captured_at`);