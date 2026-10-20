import { requireChatGPTUser } from "./chatgpt-auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Home() {
  await requireChatGPTUser("/");
  redirect('/platforms');
}
