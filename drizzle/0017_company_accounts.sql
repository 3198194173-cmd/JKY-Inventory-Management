CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  data_owner TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK(provider IN ('local','dingtalk')),
  corp_id TEXT,
  dingtalk_user_id TEXT,
  union_id TEXT,
  display_name TEXT NOT NULL,
  avatar_url TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','archived')),
  member_state TEXT NOT NULL DEFAULT 'unknown',
  membership_checked_at INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT,
  UNIQUE(corp_id,dingtalk_user_id)
);
CREATE TABLE account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX account_session_owner ON account_sessions(account_id);
CREATE TABLE login_transactions (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  return_to TEXT NOT NULL
);
CREATE TABLE account_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX account_audit_time ON account_audit(created_at);
CREATE TABLE account_group_grants (
  data_owner TEXT NOT NULL REFERENCES accounts(data_owner),
  client_id TEXT NOT NULL,
  robot_code TEXT NOT NULL,
  open_conversation_id TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(data_owner,client_id,robot_code,open_conversation_id)
);
CREATE TABLE enterprise_robot_groups (
  client_id TEXT NOT NULL,robot_code TEXT NOT NULL,open_conversation_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1,last_seen_at TEXT NOT NULL,
  PRIMARY KEY(client_id,robot_code,open_conversation_id)
);
CREATE TABLE enterprise_robot_sync (
  client_id TEXT NOT NULL,robot_code TEXT NOT NULL,last_synced_at TEXT NOT NULL,
  PRIMARY KEY(client_id,robot_code)
);
