import { Warehouse } from "lucide-react";
import { companyLoginEnabled, localLoginEnabled } from '@/lib/accounts';
import { loginConfig } from '@/lib/dingtalk-login';
import { sessionMaxAge, verificationRetryPath } from '@/lib/session-policy';

export const dynamic = 'force-dynamic';
export default async function Login({searchParams}: {searchParams:Promise<{error?:string;returnTo?:string}>}) {
  const {error,returnTo} = await searchParams;
  const ding=companyLoginEnabled(),local=localLoginEnabled(),ready=loginConfig().ready;
  const verificationUnavailable = error === 'verification_unavailable';
  const passwordForm=<form method="post" action="/api/session">
      <label>账号<input name="username" required autoComplete="username" maxLength={100} placeholder="请输入账号"/></label>
      <label>密码<input name="password" type="password" required autoComplete="current-password" maxLength={1024} placeholder="请输入密码"/></label>
      <button type="submit">登录</button>
    </form>;
  return <main className="inventory-login"><section className="inventory-login-card" aria-label="登录仓库数据">
    <div className="inventory-login-brand"><span className="compact-logo"><Warehouse size={21}/></span><strong>仓库数据</strong></div>
    <h1>登录工作台</h1>
    <p>查看仓库库存、销售与在途数据。</p>
    {error && <p role="alert">{verificationUnavailable ? '钉钉公司身份核验暂时不可用，原登录凭证已保留。请稍后点击“重试验证”，无需重新扫码；验证完成前暂停访问业务数据。' : ding?'登录未完成。请确认使用本公司钉钉账号、账户已启用，并稍后重试；持续失败请联系管理员检查应用权限。':'登录失败或尝试过于频繁，请检查账号密码后稍后重试。'}</p>}
    {verificationUnavailable && <a className="inventory-dingtalk-login" href={verificationRetryPath(returnTo)}>重试验证</a>}
    {ding && (ready?<a className="inventory-dingtalk-login" href={'/api/auth/dingtalk/start?'+new URLSearchParams({returnTo:returnTo||'/'})}>使用公司钉钉登录</a>:<p role="status">公司钉钉登录配置尚未完成，请联系管理员。</p>)}
    {ding&&<p className="inventory-login-hint">仅限本公司成员。登录默认记住 {sessionMaxAge(true)/86400} 天，使用时自动续期；手机和电脑分别记忆。首次登录自动开通，仓库和数据按账户独立保存。</p>}
    {local&&(ding?<details className="inventory-local-login"><summary>管理员恢复登录</summary>{passwordForm}</details>:passwordForm)}
  </section></main>;
}
