'use client';
import { useEffect, useRef, useState } from 'react';
import type { CollectionKind, CollectionRun, XingkongCollection } from '@/lib/kingdee-xingkong-types';

const labels:Record<CollectionKind,string>={companySales:'公司销量',companyStock:'公司库存',prices:'结算价',goods:'停止采购'};
const statuses={running:'采集中',ready:'已完成',failed:'失败',cancelled:'已停止',interrupted:'已中断'};
type RunResponse={error?:string;token:string;run:CollectionRun;runs:CollectionRun[];collections:XingkongCollection[];priceConfigured:boolean;goodsConfigured:boolean};
const time=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'});
export function KingdeeCollectionRun({onUse,onClose,initialKinds=['companySales','companyStock','prices','goods']}:{onUse:(jobs:XingkongCollection[])=>void;onClose:()=>void;initialKinds?:CollectionKind[]}){
  const [credentials,setCredentials]=useState({accountId:'20200417192138569',username:'',password:''});
  const [settings,setSettings]=useState({start:'',end:'',salesOrganization:'103',settleOrganization:'103',schemeId:'6ad1c8d85e3e71',priceListNumber:'XSJMB1110'});
  const [kinds,setKinds]=useState<CollectionKind[]>(initialKinds),[runs,setRuns]=useState<CollectionRun[]>([]),[jobs,setJobs]=useState<XingkongCollection[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[capability,setCapability]=useState({priceConfigured:false,goodsConfigured:false});
  const [selectedId,setSelectedId]=useState('');const alive=useRef(true),sending=useRef(false);
  const selected=runs.find(run=>run.id===selectedId)||runs[0],active=runs.some(run=>run.state==='running');
  const needsLogin=kinds.some(kind=>kind!=='goods');
  useEffect(()=>{alive.current=true;const abort=new AbortController();let loading=false;
    async function load(){if(loading)return;loading=true;try{const response=await fetch('/api/kingdee/collection-runs',{cache:'no-store',signal:abort.signal});const data=await response.json() as RunResponse;if(!response.ok)throw new Error(data.error||'读取失败');if(alive.current){setRuns(data.runs);setJobs(data.collections);setCapability(data);}}catch(e){if(alive.current&&!abort.signal.aborted)setError(e instanceof Error?e.message:'读取任务失败');}finally{loading=false;}}
    void load();const timer=setInterval(()=>void load(),3000);return()=>{alive.current=false;abort.abort();clearInterval(timer);};
  },[]);
  async function start(){if(sending.current)return;sending.current=true;setBusy(true);setError('');let token='';let handedOff=false;
    try{
      if(needsLogin){const response=await fetch('/api/kingdee/xingkong/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});const data=await response.json() as RunResponse;if(!response.ok)throw new Error(data.error||'登录失败');token=data.token;}
      const response=await fetch('/api/kingdee/collection-runs',{method:'POST',headers:{'Content-Type':'application/json','X-Kingdee-Session':token},body:JSON.stringify({...settings,kinds})});const data=await response.json() as RunResponse;if(!response.ok)throw new Error(data.error||'启动失败');handedOff=true;
      if(alive.current){setRuns(previous=>[data.run,...previous.filter(run=>run.id!==data.run.id)]);setSelectedId(data.run.id);}
    }catch(e){if(alive.current)setError(e instanceof Error?e.message:'启动失败');}
    finally{if(token&&!handedOff)void fetch('/api/kingdee/xingkong/connection',{method:'DELETE',headers:{'X-Kingdee-Session':token}}).catch(()=>{});if(alive.current){setCredentials(previous=>({...previous,password:''}));setBusy(false);}sending.current=false;}
  }
  async function cancel(){if(!selected)return;setBusy(true);try{const response=await fetch('/api/kingdee/collection-runs',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:selected.id})});const data=await response.json() as RunResponse;if(!response.ok)throw new Error(data.error);setRuns(previous=>previous.map(run=>run.id===data.run.id?data.run:run));}catch(e){setError(e instanceof Error?e.message:'停止失败');}finally{setBusy(false);}}
  const selectedJobs=selected?Object.values(selected.collections).map(id=>jobs.find(job=>job.id===id)).filter((job):job is XingkongCollection=>!!job):[];
  const canUse=selected?.state==='ready'&&selectedJobs.length===selected.kinds.length&&selectedJobs.every(job=>job.state==='ready'&&job.source);
  return <div className="kd-overlay kd-config-overlay"><section className="kd-modal kd-prep-config kd-module" role="dialog" aria-modal="true" aria-labelledby="kd-api-config-title">
    <header><div><h2 id="kd-api-config-title">统一采集</h2><p>一次启动，后台依次采集；各模块独立留存记录</p></div><button disabled={busy} onClick={onClose}>关闭</button></header>
    <div className="kd-module-content">{error&&<p className="kd-error" role="alert">{error}</p>}
      <fieldset disabled={busy||active} className="kd-run-modules"><legend>本次采集模块</legend>{(Object.keys(labels) as CollectionKind[]).map(kind=><label key={kind}><input type="checkbox" checked={kinds.includes(kind)} onChange={e=>setKinds(previous=>e.target.checked?[...previous,kind]:previous.filter(value=>value!==kind))}/>{labels[kind]}</label>)}</fieldset>
      {kinds.includes('goods')&&!capability.goodsConfigured&&<p className="kd-error">服务器尚未配置吉客云应用密钥。</p>}
      {kinds.includes('prices')&&!capability.priceConfigured&&<p className="kd-error">价目表真实字段映射待配置；本模块会明确报错，不会使用猜测价格。其他已完成模块会保留。</p>}
      <div className="kd-connection-layout">{needsLogin&&<section className="kd-config-block"><h3>金蝶账号</h3><fieldset disabled={busy||active}>{(['accountId','username','password'] as const).map(key=><label key={key}>{({accountId:'账套ID',username:'用户名',password:'密码'})[key]}<input type={key==='password'?'password':'text'} autoComplete="off" value={credentials[key]} onChange={e=>setCredentials(previous=>({...previous,[key]:e.target.value}))}/></label>)}</fieldset><small>密码仅用于本次登录，提交后清空；后台复用会话完成所选模块。</small></section>}
      {needsLogin&&<section className="kd-config-block"><h3>采集条件</h3><fieldset disabled={busy||active}>{(['start','end','salesOrganization','settleOrganization','schemeId','priceListNumber'] as const).map(key=><label key={key}>{({start:'销售开始日期',end:'销售截止日期',salesOrganization:'销售／价目表组织',settleOrganization:'结算组织',schemeId:'库存保存方案内码',priceListNumber:'价目表编号'})[key]}<input type={key==='start'||key==='end'?'date':'text'} value={settings[key]} onChange={e=>setSettings(previous=>({...previous,[key]:e.target.value}))}/></label>)}</fieldset><p>库存按星空保存方案实际条件查询；价目表按组织、编号查询，状态、整单状态、失效均为全部。星辰仍上传两份Excel。</p></section>}</div>
      <button className="kd-primary" disabled={busy||active||!kinds.length||(needsLogin&&(!credentials.password||!credentials.username||!settings.start||!settings.end))} onClick={()=>void start()}>{busy?'正在提交…':'开始统一采集'}</button>
      <section className="kd-run-records"><h3>统一采集记录</h3><select aria-label="选择统一采集记录" value={selected?.id||''} onChange={e=>setSelectedId(e.target.value)}>{runs.map(run=><option key={run.id} value={run.id}>{time(run.createdAt)} · {statuses[run.state]}</option>)}</select>
      {selected&&<><p>{selected.phase}</p>{selected.error&&<p className="kd-error">{selected.error}</p>}{selected.kinds.map(kind=>{const job=selectedJobs.find(item=>item.kind===kind);return <article key={kind}><strong>{labels[kind]}</strong><span>{job?job.phase:'尚未开始'}</span>{job&&<small>{job.progress.rawRows.toLocaleString('zh-CN')}行 · {job.progress.pages}页 · {time(job.createdAt)}</small>}{job?.error&&<p className="kd-error">{job.error}</p>}{job?.state==='ready'&&<><a href={'/api/kingdee/xingkong/collections/'+job.id+'?download=source'}>下载完整来源</a><button onClick={()=>onUse([job])}>采用该模块来源</button></>}</article>;})}
      {selected.state==='running'&&<button disabled={busy||selected.cancelRequested} onClick={()=>void cancel()}>停止本次统一采集</button>}{canUse&&<button className="kd-primary" onClick={()=>onUse(selectedJobs)}>采用本次全部来源</button>}</>}
      </section>
    </div><footer><span>关闭窗口后后台继续运行；服务重启时标记中断，未完成来源不会发布。</span><button onClick={onClose}>返回准备数据</button></footer>
  </section></div>;
}
