CREATE TABLE turnover_alert_deliveries (
  owner text NOT NULL,
  warehouse_code text NOT NULL,
  date text NOT NULL,
  snapshot_id text NOT NULL,
  average_threshold text NOT NULL,
  matching_count integer NOT NULL,
  state text NOT NULL,
  attempted_at text NOT NULL,
  accepted_at text,
  PRIMARY KEY (owner, warehouse_code, date)
);
