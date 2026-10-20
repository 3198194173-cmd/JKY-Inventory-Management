import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeftRight, Building2 } from 'lucide-react';
import { requireChatGPTUser } from '@/app/chatgpt-auth';
import { AccountBar } from '@/components/account-bar';
import { PlatformSignOut } from '@/components/platform-sign-out';
import { currentContext } from '@/lib/auth';
import { kingdeeView } from '@/lib/kingdee-store';
import { KingdeeDashboard } from '@/components/kingdee-dashboard';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '金蝶 · 存销分析' };

export default async function KingdeePage() {
  await requireChatGPTUser('/kingdee');
  const { actor, target } = await currentContext();
  const profile = { id: actor.id, name: actor.display_name, role: actor.role, targetId: target.id, targetName: target.display_name };
  return <main className="platform-app kingdee-app">
    <header className="platform-header"><Link href="/kingdee" className="platform-brand"><span><Building2 size={22}/></span>金蝶存销分析</Link><div className="platform-header-actions"><Link href="/platforms"><ArrowLeftRight size={16}/>切换平台</Link><PlatformSignOut/></div></header>
    <div className="platform-content">
      <AccountBar profile={profile} showPlatformSwitch={false}/>
      <KingdeeDashboard key={target.data_owner} initial={kingdeeView(target.data_owner)}/>
    </div>
  </main>;
}
