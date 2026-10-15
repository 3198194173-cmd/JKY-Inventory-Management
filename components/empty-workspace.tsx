"use client";
import { useState } from 'react';
import { Warehouse } from 'lucide-react';
import { AccountBar, type AccountProfile } from './account-bar';
export function EmptyWorkspace({profile}:{profile:AccountProfile}){
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function add(event:React.FormEvent<HTMLFormElement>){event.preventDefault();setBusy(true);setError('');const f=new FormData(event.currentTarget);try{const r=await fetch('/api/warehouses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:f.get('code'),name:f.get('name')})});const d=await r.json() as {error?:string};if(!r.ok)throw new Error(d.error||'保存失败');window.location.assign('/');}catch(e){setError(e instanceof Error?e.message:'保存失败');}finally{setBusy(false);}}
  return <main className="account-page"><AccountBar profile={profile}/><section className="empty-workspace"><Warehouse size={32}/><h1>添加你的第一个仓库</h1><p>你的仓库配置、采集记录和预警设置独立保存。</p><form onSubmit={add}><label>仓库编码<input name="code" required maxLength={50} placeholder="例如 CK007"/></label><label>仓库名称<input name="name" maxLength={80} placeholder="选填，采集后会同步官方名称"/></label>{error&&<p role="alert">{error}</p>}<button disabled={busy} type="submit">{busy?'保存中…':'添加仓库'}</button></form><a href="/login">返回登录页</a></section></main>;
}
