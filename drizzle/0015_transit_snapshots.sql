CREATE TABLE transit_snapshots (
  stock_snapshot_id TEXT PRIMARY KEY REFERENCES stock_snapshots(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  warehouse_code TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete','unresolved','failed')),
  payload TEXT,
  error TEXT
);
CREATE INDEX transit_history ON transit_snapshots(owner,warehouse_code,captured_at DESC);
