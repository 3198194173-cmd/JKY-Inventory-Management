CREATE TABLE shared_alert_deliveries (
  client_id TEXT NOT NULL,
  robot_code TEXT NOT NULL,
  group_id TEXT NOT NULL,
  warehouse_code TEXT NOT NULL,
  report_hash TEXT NOT NULL,
  owner TEXT NOT NULL,
  claim_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('sending','accepted','unconfirmed','rejected')),
  accepted_parts INTEGER NOT NULL DEFAULT 0,
  attempted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(client_id,robot_code,group_id,warehouse_code,report_hash)
);
