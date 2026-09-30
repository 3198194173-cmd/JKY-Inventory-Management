export const dynamic = 'force-dynamic';
export default async function Login({searchParams}: {searchParams:Promise<{error?:string}>}) {
  const {error} = await searchParams;
  return <main style={{maxWidth:400,margin:'12vh auto',padding:32,background:'white',borderRadius:16}}>
    <h1 style={{fontSize:24,fontWeight:700,marginBottom:12}}>仓库数据 · 登录</h1>
    <p style={{marginBottom:24,color:'#64748b'}}>登录后查看库存与销售分析。</p>
    {error && <p role="alert" style={{color:'#dc2626',marginBottom:16}}>登录失败或尝试过于频繁，请检查账号密码后稍后重试。</p>}
    <form method="post" action="/api/session">
      <label>账号<input name="username" required autoComplete="username" maxLength={100} style={{display:'block',border:'1px solid #cbd5e1',padding:10,width:'100%',margin:'8px 0 16px'}}/></label>
      <label>密码<input name="password" type="password" required autoComplete="current-password" maxLength={1024} style={{display:'block',border:'1px solid #cbd5e1',padding:10,width:'100%',margin:'8px 0 24px'}}/></label>
      <button type="submit" style={{background:'#4263eb',color:'white',padding:12,borderRadius:8,width:'100%'}}>登录</button>
    </form>
  </main>;
}
