CREATE TABLE `stock_scopes` (
	`owner` text PRIMARY KEY NOT NULL,
	`barcodes` text NOT NULL,
	`label` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `stock_snapshots` ADD `scope_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `stock_snapshots` ADD `scope_label` text DEFAULT '范围未确认' NOT NULL;--> statement-breakpoint
ALTER TABLE `stock_snapshots` ADD `scope_count` integer DEFAULT 0 NOT NULL;