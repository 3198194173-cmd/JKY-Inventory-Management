ALTER TABLE `alert_settings` ADD `notify_time` text NOT NULL DEFAULT '08:30';
--> statement-breakpoint
CREATE TABLE `manual_alert_deliveries` (
  `owner` text NOT NULL,
  `client_id` text NOT NULL,
  `robot_code` text NOT NULL,
  `request_id` text NOT NULL,
  `payload_hash` text NOT NULL,
  `warehouse_code` text NOT NULL,
  `state` text NOT NULL,
  `result` text NOT NULL,
  `attempted_at` integer NOT NULL,
  PRIMARY KEY (`owner`, `client_id`, `robot_code`, `request_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_manual_alert_cooldown` ON `manual_alert_deliveries` (`owner`, `client_id`, `robot_code`, `attempted_at`);
--> statement-breakpoint
CREATE TABLE `scheduled_alert_checks` (
  `owner` text NOT NULL, `warehouse_code` text NOT NULL, `date` text NOT NULL,
  `fingerprint` text NOT NULL,
  PRIMARY KEY (`owner`, `warehouse_code`, `date`)
);
