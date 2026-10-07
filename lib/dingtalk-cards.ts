import { randomUUID } from "node:crypto";
import { appAccessToken, sendRobotMessage, sendTurnoverReport, type RobotCredentials } from "./dingtalk";
import { cardTemplateId, type TurnoverCard } from "./dingtalk-card-data";

export async function sendRobotCard(credentials: RobotCredentials, card: TurnoverCard, png: Uint8Array, templateId: string, fetcher: typeof fetch = fetch): Promise<string> {
  const token = await appAccessToken(credentials, fetcher);
  const media = new FormData();
  media.append("media", new Blob([new Uint8Array(png)], { type: "image/png" }), "inventory-warning.png");
  const uploaded = await fetcher(`https://oapi.dingtalk.com/media/upload?${new URLSearchParams({ access_token: token, type: "image" })}`, { method: "POST", body: media, signal: AbortSignal.timeout(15_000) });
  if (!uploaded.ok) throw new Error(`钉钉报表图片上传失败（HTTP ${uploaded.status}）`);
  const image = await uploaded.json() as { errcode?: number; media_id?: string };
  if (image.errcode !== 0 || !image.media_id) throw new Error("钉钉未确认报表图片上传，请核对媒体接口权限");
  const outTrackId = randomUUID();
  const response = await fetcher("https://api.dingtalk.com/v1.0/card/instances/createAndDeliver", {
    method: "POST", headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": token },
    body: JSON.stringify({ cardTemplateId: templateId, outTrackId, callbackType: "STREAM",
      cardData: { cardParamMap: { title: card.title, summary: card.summary, footer: card.footer, reportImage: image.media_id, config: JSON.stringify({ autoLayout: true }) } },
      openSpaceId: `dtv1.card//IM_GROUP.${credentials.openConversationId}`,
      imGroupOpenSpaceModel: { supportForward: false }, imGroupOpenDeliverModel: { robotCode: credentials.robotCode },
    }), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`钉钉卡片发送失败（HTTP ${response.status}），请核对互动卡片实例写权限、模板关联应用及发布状态`);
  const result = await response.json() as { success?: boolean; result?: { outTrackId?: string; deliverResults?: { success?: boolean; spaceId?: string; spaceType?: string }[] } };
  const delivered = result.result?.deliverResults?.some(d => d.success === true && d.spaceId === credentials.openConversationId && d.spaceType === "IM_GROUP");
  if (result.success !== true || result.result?.outTrackId !== outTrackId || !delivered) throw new Error("钉钉未确认群卡片投放，请先核对群消息；不会自动重发");
  return outTrackId;
}

export async function sendInventoryReport(credentials: RobotCredentials, report: { messages: string[]; cards: TurnoverCard[] }, sender = sendRobotMessage, onAccepted?: (parts: number) => void) {
  // Injected senders keep tests offline. Production only switches after a template is configured.
  const templateId = cardTemplateId();
  if (!templateId || sender !== sendRobotMessage) return sendTurnoverReport(credentials, report.messages, sender, onAccepted);
  const { renderTurnoverCard } = await import("./dingtalk-card-image");
  for (let i = 0; i < report.cards.length; i++) {
    if (i) await new Promise(resolve => setTimeout(resolve, 1000));
    const png = await renderTurnoverCard(report.cards[i]);
    await sendRobotCard(credentials, report.cards[i], png, templateId);
    onAccepted?.(i + 1);
  }
}
