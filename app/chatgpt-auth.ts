import { redirect } from "next/navigation";
import { sessionUser } from "@/lib/local-session";
export const getChatGPTUser = sessionUser;
export async function requireChatGPTUser(_returnTo: string) {
  let user;
  try { user = await sessionUser(); } catch { redirect("/login?error=membership"); }
  if (!user) redirect('/login');
  return user;
}
export function chatGPTSignInPath(_returnTo: string) { return '/login'; }
export function chatGPTSignOutPath(_returnTo = '/') { return '/login'; }
