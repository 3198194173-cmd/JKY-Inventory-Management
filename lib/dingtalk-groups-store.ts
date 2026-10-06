import { randomUUID } from "node:crypto";
import { sqlite } from "./sqlite.mjs";
import { serverConfig } from "./server-config";
import { queryRobotGroups, queryRobotGroupName, GroupQueryError } from "./dingtalk-groups-api";

export type DingTalkGroup = { id: string; name: string; enabled: boolean };
export type DingTalkGroupState = { groups: DingTalkGroup[]; lastSyncedAt: string | null; error: string | null; syncing: boolean };
export const GROUP_SYNC_INTERVAL = 15 * 60_000;
export function robotScope(owner: string): [string, string, string] { return [owner, process.env.DINGTALK_CLIENT_ID || "", process.env.DINGTALK_ROBOT_CODE || ""]; }

export function groupState(owner: string): DingTalkGroupState {
  if (!serverConfig().robotConfigured) return { groups: [], lastSyncedAt: null, error: null, syncing: false };
  const db = sqlite(), scope = robotScope(owner);
  const state = db.prepare("SELECT * FROM dingtalk_group_sync WHERE owner=? AND client_id=? AND robot_code=?").get(...scope);
  const rows = db.prepare("SELECT open_conversation_id,name,enabled FROM dingtalk_groups WHERE owner=? AND client_id=? AND robot_code=? AND active=1 ORDER BY name,open_conversation_id").all(...scope);
  return { groups: rows.map((r: {open_conversation_id: string; name: string; enabled: number}) => ({ id: String(r.open_conversation_id), name: String(r.name), enabled: !!r.enabled })), lastSyncedAt: state?.last_synced_at as string || null, error: state?.error as string || null, syncing: Number(state?.lease_until || 0) > Date.now() };
}

export async function syncRobotGroups(owner: string, options: { force?: boolean; fetcher?: typeof fetch; signal?: AbortSignal } = {}) {
  if (!serverConfig().robotConfigured) throw new Error("请先在云端配置钉钉 ClientID、ClientSecret 和 RobotCode");
  const db = sqlite(), scope = robotScope(owner), lease = randomUUID(), now = Date.now();
  const state = db.prepare("SELECT * FROM dingtalk_group_sync WHERE owner=? AND client_id=? AND robot_code=?").get(...scope);
  if (state?.last_attempt_at && now - Date.parse(String(state.last_attempt_at)) < (options.force ? 10_000 : GROUP_SYNC_INTERVAL)) return groupState(owner);
  const claimed = db.prepare(`INSERT INTO dingtalk_group_sync (owner,client_id,robot_code,lease,lease_until,last_attempt_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(owner,client_id,robot_code) DO UPDATE SET lease=excluded.lease,lease_until=excluded.lease_until,last_attempt_at=excluded.last_attempt_at
    WHERE dingtalk_group_sync.lease_until<=?`).run(...scope, lease, now + 120_000, new Date(now).toISOString(), now);
  if (!claimed.changes) return groupState(owner);
  const credentials = { clientId: scope[1], robotCode: scope[2], clientSecret: process.env.DINGTALK_CLIENT_SECRET! };
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000);
  try {
    const ids = await queryRobotGroups(credentials, options.fetcher, signal);
    const seen = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!db.prepare("SELECT 1 FROM dingtalk_group_sync WHERE owner=? AND client_id=? AND robot_code=? AND lease=?").get(...scope, lease)) { db.exec("ROLLBACK"); return groupState(owner); }
      // Preserve choices for still-present groups; removed and rejoined groups require a new opt-in.
      db.prepare(`UPDATE dingtalk_groups SET active=0,enabled=0 WHERE owner=? AND client_id=? AND robot_code=? AND open_conversation_id NOT IN (SELECT value FROM json_each(?))`).run(...scope, JSON.stringify(ids));
      for (const id of ids) db.prepare(`INSERT INTO dingtalk_groups (owner,client_id,robot_code,open_conversation_id,last_seen_at) VALUES (?,?,?,?,?)
        ON CONFLICT(owner,client_id,robot_code,open_conversation_id) DO UPDATE SET active=1,last_seen_at=excluded.last_seen_at`).run(...scope, id, seen);
      db.prepare("UPDATE dingtalk_group_sync SET last_synced_at=?,error=NULL WHERE owner=? AND client_id=? AND robot_code=? AND lease=?").run(seen, ...scope, lease);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    // Cache names for a day and bound lookups so large group lists do not block inventory collection.
    const names = db.prepare(`SELECT open_conversation_id FROM dingtalk_groups WHERE owner=? AND client_id=? AND robot_code=? AND active=1
      AND (name_checked_at IS NULL OR name_checked_at<?) ORDER BY name_checked_at LIMIT 20`).all(...scope, new Date(now - 86_400_000).toISOString());
    for (const row of names) {
      if (signal.aborted) break;
      const id = String(row.open_conversation_id);
      try {
        const name = await queryRobotGroupName(credentials, id, options.fetcher, signal);
        db.prepare("UPDATE dingtalk_groups SET name=? WHERE owner=? AND client_id=? AND robot_code=? AND open_conversation_id=?").run(name, ...scope, id);
      } catch { /* Group name permissions must not invalidate verified membership. */ }
      db.prepare("UPDATE dingtalk_groups SET name_checked_at=? WHERE owner=? AND client_id=? AND robot_code=? AND open_conversation_id=?").run(new Date().toISOString(), ...scope, id);
    }
  } catch (error) {
    const message = error instanceof GroupQueryError ? error.message : "群同步失败或超时，已保留原群列表；请检查云端网络及应用凭证";
    db.prepare("UPDATE dingtalk_group_sync SET error=? WHERE owner=? AND client_id=? AND robot_code=? AND lease=?").run(message, ...scope, lease);
  } finally {
    db.prepare("UPDATE dingtalk_group_sync SET lease=NULL,lease_until=0 WHERE owner=? AND client_id=? AND robot_code=? AND lease=?").run(...scope, lease);
  }
  return groupState(owner);
}

export function validateGroupSelection(owner: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000 || value.some(id => typeof id !== "string")) throw new Error("接收预警的群选择无效");
  const available = new Set(groupState(owner).groups.map(g => g.id));
  const ids = [...new Set(value as string[])];
  if (ids.some(id => !available.has(id))) throw new Error("群列表已变化，请刷新后重新选择接收预警的群");
  return ids;
}
