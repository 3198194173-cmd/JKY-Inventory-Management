CREATE TABLE dingtalk_groups (
  owner text NOT NULL,
  client_id text NOT NULL,
  robot_code text NOT NULL,
  open_conversation_id text NOT NULL,
  name text NOT NULL DEFAULT '',
  enabled integer NOT NULL DEFAULT 0,
  active integer NOT NULL DEFAULT 1,
  last_seen_at text NOT NULL,
  name_checked_at text,
  PRIMARY KEY (owner, client_id, robot_code, open_conversation_id)
);
CREATE TABLE dingtalk_group_sync (
  owner text NOT NULL,
  client_id text NOT NULL,
  robot_code text NOT NULL,
  last_attempt_at text,
  last_synced_at text,
  error text,
  lease text,
  lease_until integer NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, client_id, robot_code)
);
CREATE TABLE turnover_group_deliveries (
  owner text NOT NULL,
  client_id text NOT NULL,
  robot_code text NOT NULL,
  open_conversation_id text NOT NULL,
  warehouse_code text NOT NULL,
  date text NOT NULL,
  snapshot_id text NOT NULL,
  average_threshold text NOT NULL,
  matching_count integer NOT NULL,
  state text NOT NULL,
  attempted_at text NOT NULL,
  accepted_at text,
  PRIMARY KEY (owner, client_id, robot_code, open_conversation_id, warehouse_code, date)
);
