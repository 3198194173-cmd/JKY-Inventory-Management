ALTER TABLE manual_alert_deliveries ADD COLUMN snapshot_id text NOT NULL DEFAULT '';
ALTER TABLE manual_alert_deliveries ADD COLUMN average_threshold text NOT NULL DEFAULT '';
CREATE INDEX idx_manual_alert_snapshot ON manual_alert_deliveries
  (owner, client_id, robot_code, warehouse_code, snapshot_id, average_threshold);
