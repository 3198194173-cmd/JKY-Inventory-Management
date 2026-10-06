CREATE TABLE `inbound_reconciliations` (
	`owner` text NOT NULL,
	`warehouse_code` text NOT NULL,
	`goods_no` text NOT NULL,
	`date` text NOT NULL,
	`before_snapshot_id` text NOT NULL,
	`after_snapshot_id` text NOT NULL,
	`unit_name` text NOT NULL,
	`raw_difference` text NOT NULL,
	`opening_quantity` text NOT NULL,
	`closing_quantity` text NOT NULL,
	`status` text NOT NULL,
	`inbound_quantity` text,
	`corrected_quantity` text,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`records` text DEFAULT '[]' NOT NULL,
	`error` text,
	`checked_at` text NOT NULL,
	PRIMARY KEY(`owner`, `warehouse_code`, `goods_no`, `before_snapshot_id`, `after_snapshot_id`),
	FOREIGN KEY (`before_snapshot_id`) REFERENCES `stock_snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`after_snapshot_id`) REFERENCES `stock_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_inbound_owner_warehouse_date` ON `inbound_reconciliations` (`owner`,`warehouse_code`,`date`);