CREATE INDEX IF NOT EXISTS idx_snapshots_warehouse_latest ON stock_snapshots(owner,warehouse_code,coverage,status,captured_at,id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_runs_warehouse_time ON sync_runs(owner,warehouse_code,started_at);
