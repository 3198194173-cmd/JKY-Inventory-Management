CREATE TABLE warehouse_share_candidates (
  token_hash TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES accounts(id),
  identity_json TEXT NOT NULL,
  mobile_masked TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX warehouse_share_candidate_expiry ON warehouse_share_candidates(expires_at);
CREATE TABLE warehouse_shares (
  request_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES accounts(id),
  target_id TEXT NOT NULL REFERENCES accounts(id),
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
