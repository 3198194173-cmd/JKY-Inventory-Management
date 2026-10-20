import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Building2, ChartNoAxesCombined, Layers3 } from 'lucide-react';
import { requireChatGPTUser } from '@/app/chatgpt-auth';
import { AccountBar } from '@/components/account-bar';
import { PlatformSignOut } from '@/components/platform-sign-out';
import { currentContext } from '@/lib/auth';
import { platformEntryPath } from '@/lib/platform-routing';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '选择平台 · 数据分析工作台' };

export default async function PlatformsPage({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  const { returnTo } = await searchParams;
  await requireChatGPTUser('/platforms');
  const { actor, target } = await currentContext();
  const profile = { id: actor.id, name: actor.display_name, role: actor.role, targetId: target.id, targetName: target.display_name };
  return <main className="platform-app">
    <header className="platform-header"><Link href="/platforms" className="platform-brand"><span><Layers3 size={22}/></span>数据分析工作台</Link><PlatformSignOut/></header>
    <div className="platform-content">
      <AccountBar profile={profile} showPlatformSwitch={false}/>
      <section className="platform-welcome"><p className="platform-eyebrow">CASEBANG 数据分析</p><h1>选择数据平台</h1><p>按业务进入对应系统，管理库存与销售数据。</p></section>
      <section className="platform-options" aria-label="选择数据平台">
        <Link className="platform-option" prefetch={false} href={platformEntryPath('jackyun', returnTo)}>
          <span className="platform-option-icon"><ChartNoAxesCombined size={28}/></span><span className="platform-state">现有业务</span>
          <h2>吉客云</h2><p>查看仓库库存、销量估算与入库在途，管理采集和预警。</p>
          <span className="platform-tags"><span>仓库库存</span><span>在途记录</span><span>库存预警</span></span>
          <span className="platform-enter">进入吉客云<ArrowRight size={18}/></span>
        </Link>
        <Link className="platform-option platform-option-kingdee" prefetch={false} href={platformEntryPath('kingdee', returnTo)}>
          <span className="platform-option-icon"><Building2 size={28}/></span><span className="platform-state">数据准备阶段</span>
          <h2>金蝶</h2><p>整合星空和星辰的公司与门店数据，制作存销明细。</p>
          <span className="platform-tags"><span>公司与门店</span><span>四维分类</span><span>结算价</span></span>
          <span className="platform-enter">进入金蝶<ArrowRight size={18}/></span>
        </Link>
      </section>
      <p className="platform-footnote">共用登录身份，各平台的业务数据、配置与报表分别管理。</p>
    </div>
  </main>;
}
