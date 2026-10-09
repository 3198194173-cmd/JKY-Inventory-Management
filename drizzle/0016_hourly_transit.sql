CREATE TABLE transit_checks (
  owner TEXT NOT NULL,
  warehouse_code TEXT NOT NULL,
  last_attempt INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  token TEXT NOT NULL,
  PRIMARY KEY(owner,warehouse_code)
);
CREATE TABLE transit_completion_marks (
  owner TEXT NOT NULL,
  warehouse_code TEXT NOT NULL,
  goods_no TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY(owner,warehouse_code,goods_no)
);
CREATE TABLE transit_captures (
  id TEXT PRIMARY KEY,
  stock_snapshot_id TEXT NOT NULL REFERENCES stock_snapshots(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  warehouse_code TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete','unresolved','failed')),
  payload TEXT,
  error TEXT
);
INSERT INTO transit_captures SELECT stock_snapshot_id,stock_snapshot_id,owner,warehouse_code,captured_at,status,payload,error FROM transit_snapshots;
DROP TABLE transit_snapshots;
ALTER TABLE transit_captures RENAME TO transit_snapshots;
CREATE INDEX transit_history ON transit_snapshots(owner,warehouse_code,captured_at DESC);
CREATE INDEX transit_stock_history ON transit_snapshots(owner,warehouse_code,stock_snapshot_id,captured_at DESC);
