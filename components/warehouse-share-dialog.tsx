"use client";
import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { ShareResult } from '@/lib/warehouse-sharing';
import '@/app/warehouse-sharing.css';

type Options={warehouses:{code:string;name:string;snapshots:number}[];accounts:{id:string;name:string;userId:string}[]};
type Recipient={lookupToken:string;name:string;userId:string;maskedMobile:string;existingAccount:boolean};
async function api<T>(path:string,body?:unknown):Promise<T>{
  const response=await fetch(path,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json() as T & {error?:string};if(!response.ok)throw new Error(data.error||'操作失败，请稍后重试');return data;
}
export function WarehouseShareDialog({onClose,onComplete}:{onClose:()=>void;onComplete:()=>Promise<void>}){
  const [options,setOptions]=useState<Options|null>(null),[mode,setMode]=useState<'phone'|'account'>('phone'),[mobile,setMobile]=useState(''),[recipient,setRecipient]=useState<Recipient|null>(null),[targetId,setTargetId]=useState(''),[codes,setCodes]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<ShareResult|null>(null);
  const requestId=useRef('');
  useEffect(()=>{let active=true;api<Options>('/api/admin/warehouse-share').then(d=>{if(active)setOptions(d);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
  function changed(){requestId.current='';setError('');}
  async function lookup(){
    setBusy(true);setRecipient(null);changed();
    try{setRecipient(await api<Recipient>('/api/admin/warehouse-share/lookup',{mobile}));}catch(e){setError(e instanceof Error?e.message:'查询失败');}finally{setBusy(false);}
  }
  async function copy(){
    setBusy(true);setError('');requestId.current||=crypto.randomUUID();
    try{
      const copied=await api<ShareResult>('/api/admin/warehouse-share',{requestId:requestId.current,warehouseCodes:codes,...(mode==='phone'?{lookupToken:recipient?.lookupToken}:{targetAccountId:targetId})});
      setResult(copied);setMobile('');setRecipient(null);
      try{await onComplete();}catch{setError('复制已完成，账户列表刷新失败，关闭窗口后刷新页面即可。');}
    }catch(e){setError(e instanceof Error?e.message:'复制失败');}finally{setBusy(false);}
  }
  const selectedAccount=options?.accounts.find(a=>a.id===targetId),ready=mode==='phone'?!!recipient:!!selectedAccount;
  return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose();}}><DialogContent className="warehouse-share-dialog" showCloseButton={!busy} onEscapeKeyDown={e=>{if(busy)e.preventDefault();}} onInteractOutside={e=>{if(busy)e.preventDefault();}}>
    <DialogTitle>仓库分享</DialogTitle>
    <DialogDescription>将你的仓库配置和已有数据复制给公司同事，之后各自独立使用。</DialogDescription>
    {error&&<p role="alert" className="share-error">{error}</p>}
    {result?<div className="share-result" role="status">
      <h3>已复制给 {result.targetName}</h3>
      <p>成功复制 {result.copied.length} 个仓库，跳过 {result.skipped.length} 个已有仓库。</p>
      {result.copied.map(w=><p key={w.code}><strong>{w.code} · {w.name}</strong><br/>{w.snapshots} 份库存快照 · {w.inbound} 条销售/入库核验 · {w.transit} 份在途记录</p>)}
      {!!result.skipped.length&&<p>已有同编码仓库，保持原数据：{result.skipped.join('、')}</p>}
      <p>{result.prepared?'账户已提前开通，同事首次钉钉登录即可看到数据，登录前不运行后台采集。':'同事刷新页面后即可看到复制的仓库。'}自动预警已关闭，接收群需另行授权与设置。</p>
      <button className="share-primary" onClick={onClose} disabled={busy}>完成</button>
    </div>:<>
      {!options?<p role="status">正在加载…</p>:<fieldset disabled={busy} className="share-fields">
        <legend>1. 选择接收人</legend>
        <div className="share-modes"><button type="button" aria-pressed={mode==='phone'} onClick={()=>{setMode('phone');changed();}}>手机号查找</button><button type="button" aria-pressed={mode==='account'} onClick={()=>{setMode('account');changed();}}>已有账户</button></div>
        {mode==='phone'?<form className="share-lookup" onSubmit={e=>{e.preventDefault();void lookup();}}><label htmlFor="share-mobile">同事的钉钉手机号</label><div><input id="share-mobile" type="tel" autoComplete="off" placeholder="支持 +86 手机号" value={mobile} onChange={e=>{setMobile(e.target.value);setRecipient(null);changed();}}/><button type="submit" disabled={busy||!mobile.trim()}>查找同事</button></div></form>:<label className="share-select">接收账户<select value={targetId} onChange={e=>{setTargetId(e.target.value);changed();}}><option value="">请选择公司成员</option>{options.accounts.map(a=><option key={a.id} value={a.id}>{a.name} · {a.userId}</option>)}</select></label>}
        {(mode==='phone'?recipient:selectedAccount)&&<div className="share-recipient"><strong>{mode==='phone'?recipient?.name:selectedAccount?.name}</strong><span>钉钉 userId：{mode==='phone'?recipient?.userId:selectedAccount?.userId}</span>{mode==='phone'&&recipient&&<span>{recipient.maskedMobile} · {recipient.existingAccount?'已有系统账户':'尚未开通，确认复制时创建账户'}</span>}</div>}
        <h3>2. 选择你要复制的仓库</h3>
        <div className="share-warehouses">{options.warehouses.length?options.warehouses.map(w=><label key={w.code}><input type="checkbox" checked={codes.includes(w.code)} onChange={e=>{setCodes(prev=>e.target.checked?[...prev,w.code]:prev.filter(c=>c!==w.code));changed();}}/><span><strong>{w.code} · {w.name}</strong><small>{w.snapshots} 份已有库存快照</small></span></label>):<p>你自己的账户还没有仓库，请先返回库存工作台添加。</p>}</div>
        <p className="share-note">复制库存、销售核验和在途历史。对方已有同编码仓库会跳过；自动预警关闭，接收群和发送记录不复制。</p>
      </fieldset>}
      <footer className="share-footer"><button onClick={onClose} disabled={busy}>取消</button><button className="share-primary" disabled={busy||!ready||!codes.length} onClick={()=>void copy()}>{busy?'正在处理…':`确认复制${codes.length?` ${codes.length} 个仓库`:''}`}</button></footer>
    </>}
  </DialogContent></Dialog>;
}
