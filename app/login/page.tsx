import { Warehouse } from "lucide-react";

export const dynamic = 'force-dynamic';
export default async function Login({searchParams}: {searchParams:Promise<{error?:string}>}) {
  const {error} = await searchParams;
  return <main className="inventory-login"><section className="inventory-login-card" aria-label="登录仓库数据">
    <div className="inventory-login-brand"><span className="compact-logo"><Warehouse size={21}/></span><strong>仓库数据</strong></div>
    <h1>登录工作台</h1>
    <p>查看仓库库存、销售与在途数据。</p>
    {error && <p role="alert">登录失败或尝试过于频繁，请检查账号密码后稍后重试。</p>}
    <form method="post" action="/api/session">
      <label>账号<input name="username" required autoComplete="username" maxLength={100} placeholder="请输入账号"/></label>
      <label>密码<input name="password" type="password" required autoComplete="current-password" maxLength={1024} placeholder="请输入密码"/></label>
      <button type="submit">登录</button>
    </form>
  </section></main>;
}
