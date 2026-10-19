import { redirect } from 'next/navigation';
import { requireChatGPTUser } from '@/app/chatgpt-auth';
import { AccountManager } from '@/components/account-manager';
import { SessionKeeper } from '@/components/session-keeper';
export const dynamic='force-dynamic';
export default async function AccountsPage(){const user=await requireChatGPTUser('/admin/accounts');if(user.role!=='admin')redirect('/');return <><SessionKeeper/><AccountManager actorId={user.accountId}/></>;}
