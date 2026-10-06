import { appAccessToken, type RobotCredentials } from "./dingtalk";

type Credentials = Omit<RobotCredentials, "openConversationId">;
export class GroupQueryError extends Error {}

async function request(path: string, body: object, token: string, fetcher: typeof fetch, signal?: AbortSignal) {
  const response = await fetcher(`https://api.dingtalk.com${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": token },
    body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new GroupQueryError(`群查询失败（HTTP ${response.status}），请检查钉钉接口权限及应用发布状态`);
  const data = await response.json() as Record<string, unknown>;
  if (!data || typeof data !== "object") throw new GroupQueryError("钉钉群查询响应格式异常");
  return data;
}

// Official SDK: QueryRobotInstanceInGroupInfo. Complete enumeration before replacing cached membership.
export async function queryRobotGroups(credentials: Credentials, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<string[]> {
  const token = await appAccessToken(credentials, fetcher);
  const ids = new Set<string>(), cursors = new Set<string>();
  let nextToken: string | undefined;
  for (let page = 0; page < 100; page++) {
    const data = await request("/v1.0/robot/installed/groups/query", { robotCode: credentials.robotCode, maxResult: 10, ...(nextToken ? { nextToken } : {}) }, token, fetcher, signal);
    if (!Array.isArray(data.openConversationIds) || typeof data.hasMore !== "boolean" || data.openConversationIds.some(id => typeof id !== "string" || !id.trim() || id.length > 512)) {
      throw new GroupQueryError("钉钉群列表响应不完整，已保留原群列表；请核对接口权限");
    }
    for (const id of data.openConversationIds as string[]) ids.add(id);
    if (!data.hasMore) return [...ids];
    if (typeof data.nextToken !== "string" || !data.nextToken || cursors.has(data.nextToken)) throw new GroupQueryError("钉钉群分页异常，已保留原群列表");
    cursors.add(data.nextToken); nextToken = data.nextToken;
  }
  throw new GroupQueryError("钉钉群分页超过安全上限，已保留原群列表");
}

// Some ordinary groups cannot use the scene-group API. Their verified IDs remain selectable.
export async function queryRobotGroupName(credentials: Credentials, id: string, fetcher: typeof fetch = fetch, signal?: AbortSignal) {
  const token = await appAccessToken(credentials, fetcher);
  const data = await request("/v1.0/im/sceneGroups/query", { openConversationId: id }, token, fetcher, signal);
  if (data.success === false || typeof data.title !== "string" || !data.title.trim() || (data.openConversationId && data.openConversationId !== id)) throw new GroupQueryError("未取得群名称");
  return data.title.slice(0, 200);
}
