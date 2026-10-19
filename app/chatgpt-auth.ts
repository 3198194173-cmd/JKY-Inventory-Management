import { redirect } from "next/navigation";
import { sessionUser } from "@/lib/local-session";
import { AccessError } from '@/lib/accounts';
import { verificationRetryPath } from '@/lib/session-policy';
export const getChatGPTUser = sessionUser;
export async function requireChatGPTUser(_returnTo: string) {
  let user;
  try { user = await sessionUser(); } catch (error) {
    if (error instanceof AccessError && error.status === 503) redirect('/login?' + new URLSearchParams({ error: 'verification_unavailable', returnTo: verificationRetryPath(_returnTo) }));
    redirect("/login?error=membership");
  }
  if (!user) redirect('/login');
  return user;
}
export function chatGPTSignInPath(_returnTo: string) { return '/login'; }
export function chatGPTSignOutPath(_returnTo = '/') { return '/login'; }
