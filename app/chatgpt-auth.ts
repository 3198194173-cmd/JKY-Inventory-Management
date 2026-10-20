import { redirect } from "next/navigation";
import { sessionUser } from "@/lib/local-session";
import { AccessError } from '@/lib/accounts';
import { verificationRetryPath } from '@/lib/session-policy';
export const getChatGPTUser = sessionUser;
export function chatGPTSignInPath(returnTo: string) { const safe = verificationRetryPath(returnTo); return safe === '/' ? '/login' : '/login?' + new URLSearchParams({ returnTo: safe }); }
export async function requireChatGPTUser(_returnTo: string) {
  let user;
  try { user = await sessionUser(); } catch (error) {
    if (error instanceof AccessError && error.status === 503) redirect('/login?' + new URLSearchParams({ error: 'verification_unavailable', returnTo: verificationRetryPath(_returnTo) }));
    redirect('/login?' + new URLSearchParams({ error: 'membership', returnTo: verificationRetryPath(_returnTo) }));
  }
  if (!user) redirect(chatGPTSignInPath(_returnTo));
  return user;
}
export function chatGPTSignOutPath(_returnTo = '/') { return '/login'; }
