import { randomUUID } from "node:crypto";
import { appAccessToken, sendRobotMessage, sendTurnoverReport, type RobotCredentials } from "./dingtalk";
import { cardTemplateId, normalizeCardTemplateId, nativeCardParams, type TurnoverCard } from "./dingtalk-card-data";

export class DingTalkCardError extends Error {
  constructor(message: string, public readonly rejected: boolean) { super(message); }
}

async function cardResponseError(response: Response, secrets: string[], templateId: string): Promise<DingTalkCardError> {
  const payload: unknown = await response.json().catch(() => null);
  const data = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  // Do not forward upstream message/body: it can echo tokens, credentials or request data.
  const identifier = (value: unknown) => {
    if ((typeof value !== "string" && typeof value !== "number") || !/^[\w.:-]{1,128}$/.test(String(value))) return "";
    let safe = String(value);
    for (const secret of secrets.filter(Boolean).sort((a,b) => b.length-a.length)) safe = safe.replaceAll(secret, "[已隐藏]");
    return safe;
  };
  const code = identifier(data.code ?? data.errcode);
  const requestId = identifier(data.requestid ?? data.requestId);
  const cause = `${typeof data.code === "string" ? data.code : ""} ${typeof data.message === "string" ? data.message : ""}`;
  let hint = response.status === 403 ? "请核对互动卡片实例写权限和模板关联应用" : response.status === 400 ? "请核对卡片模板 ID、群会话 ID 和请求参数" : "请根据错误码检查钉钉接口状态";
  if (/template|schema/i.test(cause)) hint = `接口模板 ID：${templateId}；请确认这是自己的已保存模板，并关联当前应用；案例预览需先创建为自己的模板`;
  else if (/permission|accessdenied|forbidden/i.test(cause)) hint = "请核对互动卡片实例写权限、应用发布状态和模板关联应用";
  else if (/openspace|conversation|spaceid/i.test(cause)) hint = "请刷新群列表，确认目标群会话 ID 和机器人群成员状态";
  else if (/robot/i.test(cause)) hint = "请核对机器人编码、应用发布状态和机器人是否仍在群中";
  else if (/callback/i.test(cause)) hint = "请核对卡片回调模式及相关参数";
  return new DingTalkCardError(`钉钉卡片发送失败（HTTP ${response.status}${code ? `；错误码：${code}` : ""}）${hint}${requestId ? `；请求编号：${requestId}` : ""}`, [400,401,403,404,422].includes(response.status));
}

export async function sendRobotCard(credentials: RobotCredentials, card: TurnoverCard, templateId: string, fetcher: typeof fetch = fetch): Promise<string> {
  let apiTemplateId: string;
  try { apiTemplateId = normalizeCardTemplateId(templateId); }
  catch { throw new DingTalkCardError("钉钉卡片尚未发送：模板 ID 格式无效，请从模板列表复制完整 ID", true); }
  if (!apiTemplateId) throw new DingTalkCardError("钉钉卡片模板 ID 不能为空", true);
  let cardParamMap: Record<string, string>;
  try { cardParamMap = nativeCardParams(card); }
  catch { throw new DingTalkCardError("钉钉卡片尚未发送：报告数据准备失败，请重新预览", true); }
  let token: string;
  try { token = await appAccessToken(credentials, fetcher); }
  catch { throw new DingTalkCardError("钉钉卡片尚未发送：获取应用访问令牌失败，请检查应用凭证及服务器到钉钉的网络", true); }
  const outTrackId = randomUUID();
  let response: Response;
  try { response = await fetcher("https://api.dingtalk.com/v1.0/card/instances/createAndDeliver", {
    method: "POST", headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": token },
    body: JSON.stringify({ cardTemplateId: apiTemplateId, outTrackId, callbackType: "STREAM",
      cardData: { cardParamMap },
      openSpaceId: `dtv1.card//IM_GROUP.${credentials.openConversationId}`,
      imGroupOpenSpaceModel: { supportForward: false }, imGroupOpenDeliverModel: { robotCode: credentials.robotCode },
    }), signal: AbortSignal.timeout(15_000),
  }); } catch (error) {
    const timedOut = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
    throw new DingTalkCardError(`钉钉卡片投放${timedOut ? "请求超时" : "网络请求异常"}，未取得受理回执；请先核对群消息，本次不会自动重发`, false);
  }
  if (!response.ok) throw await cardResponseError(response, [credentials.clientSecret, token, credentials.openConversationId], apiTemplateId);
  const result = await response.json().catch(() => { throw new DingTalkCardError("钉钉卡片投放响应格式异常，未取得有效受理回执；请先核对群消息，本次不会自动重发", false); }) as { success?: boolean; result?: { outTrackId?: string; deliverResults?: { success?: boolean; spaceId?: string; spaceType?: string }[] } };
  const delivered = result.result?.deliverResults?.some(d => d.success === true && d.spaceId === credentials.openConversationId && d.spaceType === "IM_GROUP");
  if (result.success !== true || result.result?.outTrackId !== outTrackId || !delivered) throw new DingTalkCardError("钉钉未确认群卡片投放，请先核对群消息；不会自动重发", false);
  return outTrackId;
}

export async function sendInventoryReport(credentials: RobotCredentials, report: { messages: string[]; cards: TurnoverCard[] }, sender = sendRobotMessage, onAccepted?: (parts: number) => void) {
  // Injected senders keep tests offline. Production only switches after a template is configured.
  const templateId = cardTemplateId();
  if (!templateId || sender !== sendRobotMessage) return sendTurnoverReport(credentials, report.messages, sender, onAccepted);
  for (let i = 0; i < report.cards.length; i++) {
    if (i) await new Promise(resolve => setTimeout(resolve, 1000));
    await sendRobotCard(credentials, report.cards[i], templateId);
    onAccepted?.(i + 1);
  }
}
