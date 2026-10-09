CREATE TABLE warehouse_alert_settings (
  owner text NOT NULL, warehouse_code text NOT NULL,
  enabled integer NOT NULL DEFAULT 0, threshold text NOT NULL DEFAULT '0',
  turnover_average_threshold text NOT NULL DEFAULT '3',
  turnover_days text NOT NULL DEFAULT '30',
  excluded_name_keywords text NOT NULL DEFAULT '[]',
  notify_time text NOT NULL DEFAULT '08:30', revision integer NOT NULL DEFAULT 0,
  last_sent_at text, last_result text,
  PRIMARY KEY (owner,warehouse_code)
);
INSERT INTO warehouse_alert_settings (owner,warehouse_code,enabled,threshold,turnover_average_threshold,notify_time)
  SELECT w.owner,w.code,COALESCE(a.enabled,0),COALESCE(a.threshold,'0'),COALESCE(a.turnover_average_threshold,'3'),COALESCE(a.notify_time,'08:30')
  FROM warehouses w LEFT JOIN alert_settings a ON a.owner=w.owner;
CREATE TRIGGER initialize_warehouse_alerts AFTER INSERT ON warehouses BEGIN
  INSERT OR IGNORE INTO warehouse_alert_settings (owner,warehouse_code) VALUES (NEW.owner,NEW.code);
END;
CREATE TABLE warehouse_alert_groups (
  owner text NOT NULL, warehouse_code text NOT NULL, client_id text NOT NULL,
  robot_code text NOT NULL, open_conversation_id text NOT NULL,
  PRIMARY KEY (owner,warehouse_code,client_id,robot_code,open_conversation_id)
);
INSERT INTO warehouse_alert_groups
  SELECT w.owner,w.code,g.client_id,g.robot_code,g.open_conversation_id
  FROM warehouses w JOIN dingtalk_groups g ON g.owner=w.owner AND g.enabled=1 AND g.active=1;
ALTER TABLE manual_alert_deliveries ADD COLUMN rule_hash text NOT NULL DEFAULT '';
ALTER TABLE turnover_group_deliveries ADD COLUMN rule_hash text NOT NULL DEFAULT '';
CREATE TABLE alert_report_exports (
  token_hash text PRIMARY KEY, owner text NOT NULL, warehouse_code text NOT NULL,
  card_json text NOT NULL, created_at integer NOT NULL, expires_at integer NOT NULL
);
CREATE INDEX idx_alert_report_expiry ON alert_report_exports(expires_at);
