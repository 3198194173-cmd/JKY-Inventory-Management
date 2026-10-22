'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Boxes, CheckCircle2, Database, Download, History, LoaderCircle, Play, Plug, X } from 'lucide-react';
import { type XingkongCollection, type XingkongKind, type XingkongProbe } from '@/lib/kingdee-xingkong-types';
import type { KingdeeRules } from '@/lib/kingdee-types';
import { KingdeeWarehouseScope } from './kingdee-warehouse-scope';

type SavedProbe=Pick<XingkongProbe,'id'|'createdAt'|'kind'|'returnedRows'|'total'>;
const time=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'});
const count=(value:number)=>value.toLocaleString('zh-CN');
const stateLabel={running:'采集中',cancelling:'正在停止',ready:'已完成',failed:'失败',cancelled:'已停止',interrupted:'已中断'};
export function KingdeeXingkongProbe({initialKind,rules,onManageWarehouses,onUse,onClose}:{initialKind:XingkongKind;rules:KingdeeRules;onManageWarehouses:()=>void;onUse:(collection:XingkongCollection)=>void;onClose:()=>void}){
  const kind=initialKind,isStock=kind==='companyStock',title=isStock?'公司库存':'公司销量';
  const [panel,setPanel]=useState<'configure'|'records'|'sample'>('configure');
  const [credentials,setCredentials]=useState({accountId:'20200417192138569',username:'',password:''});
  const [settings,setSettings]=useState({start:'',end:'',salesOrganization:'103',settleOrganization:'103',schemeId:'6ad1c8d85e3e71'});
  const [session,setSession]=useState<{expiresAt:string}|null>(null),[busy,setBusy]=useState(''),[error,setError]=useState('');
  const [probe,setProbe]=useState<XingkongProbe|null>(null),[history,setHistory]=useState<SavedProbe[]>([]);
  const [collections,setCollections]=useState<XingkongCollection[]>([]),[collectionId,setCollectionId]=useState(''),[loadError,setLoadError]=useState('');
  const selected=collections.find(job=>job.id===collectionId)||collections[0];
  const active=collections.some(job=>job.state==='running'||job.state==='cancelling');
  const controller=useRef<AbortController|null>(null),sessionToken=useRef(''),running=useRef(false),alive=useRef(true);
  const valid=!!settings.start&&!!settings.end&&(isStock?!!settings.schemeId.trim():!!settings.salesOrganization.trim()&&!!settings.settleOrganization.trim());
  function dropConnection(){controller.current?.abort();const token=sessionToken.current;sessionToken.current='';if(token)void fetch('/api/kingdee/xingkong/connection',{method:'DELETE',headers:{'X-Kingdee-Session':token},keepalive:true}).catch(()=>{});}
  useEffect(()=>{
    alive.current=true;const abort=new AbortController();let loading=false;
    async function load(){if(loading)return;loading=true;try{
      const [jobs,samples]=await Promise.all([fetch('/api/kingdee/xingkong/collections?kind='+kind,{signal:abort.signal,cache:'no-store'}),fetch('/api/kingdee/xingkong/probes?kind='+kind,{signal:abort.signal,cache:'no-store'})]);
      if(!jobs.ok||!samples.ok)throw new Error();
      const data=await jobs.json() as {collections:XingkongCollection[]},sampleData=await samples.json() as {probes:SavedProbe[]};
      if(alive.current){setCollections(previous=>{const merged=new Map(previous.map(job=>[job.id,job]));for(const job of data.collections){const old=merged.get(job.id);if(!old||old.updatedAt<=job.updatedAt)merged.set(job.id,job);}return [...merged.values()].filter(job=>job.kind===kind).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,15);});setHistory(sampleData.probes.filter(item=>item.kind===kind));setLoadError('');}
    }catch{if(alive.current&&!abort.signal.aborted)setLoadError('记录暂时读取失败，后台采集不会因此停止。请稍后重新打开查看。');}finally{loading=false;}}
    void load();const timer=setInterval(()=>void load(),5000);return()=>{alive.current=false;abort.abort();clearInterval(timer);dropConnection();};
  },[kind]);
  useEffect(()=>{if(!session)return;const timer=setTimeout(()=>{dropConnection();setSession(null);setError('连接已过期，请重新测试连接。');},Math.max(0,Date.parse(session.expiresAt)-Date.now()));return()=>clearTimeout(timer);},[session]);
  function updateCredentials(key:keyof typeof credentials,value:string){if(sessionToken.current){dropConnection();setSession(null);}setCredentials(previous=>({...previous,[key]:value}));setError('');}
  async function run(action:'connect'|'probe'|'history'|'collect'|'cancel',id?:string){
    if(running.current)return;running.current=true;setBusy(action);setError('');const abort=new AbortController();controller.current=abort;
    try{
      const path=action==='connect'?'/api/kingdee/xingkong/connection':action==='probe'?'/api/kingdee/xingkong/probes':action==='collect'?'/api/kingdee/xingkong/collections':action==='cancel'?'/api/kingdee/xingkong/collections/'+id+'/cancel':'/api/kingdee/xingkong/probes/'+id;
      const response=await fetch(path,{method:action==='history'?'GET':'POST',signal:abort.signal,headers:{'Content-Type':'application/json',...(['probe','collect'].includes(action)?{'X-Kingdee-Session':sessionToken.current}:{})},...(action==='history'?{}:{body:JSON.stringify(action==='connect'?credentials:action==='cancel'?{}:{kind,...settings})})});
      const result=await response.json() as XingkongProbe&{error?:string;token?:string;expiresAt:string;probe:XingkongProbe;collection:XingkongCollection};
      if(!response.ok){if(['probe','collect'].includes(action)&&response.status===401){dropConnection();setSession(null);}throw new Error(result.error||'请求失败，请稍后重试');}
      if(!alive.current){if(action==='connect'&&result.token)void fetch('/api/kingdee/xingkong/connection',{method:'DELETE',headers:{'X-Kingdee-Session':result.token},keepalive:true}).catch(()=>{});return;}
      if(action==='connect'){sessionToken.current=result.token!;setSession({expiresAt:result.expiresAt});}
      else if(action==='collect'||action==='cancel'){
        if(result.collection.kind!==kind)throw new Error('返回的采集记录与当前模块不符');
        setCollections(previous=>[result.collection,...previous.filter(job=>job.id!==result.collection.id)]);setCollectionId(result.collection.id);setPanel('records');
        if(action==='collect'){sessionToken.current='';setSession(null);}
      }else{const sample=action==='history'?result:result.probe;if(sample.kind!==kind)throw new Error('样本不属于当前模块');setProbe(sample);setPanel('sample');if(action==='probe')setHistory(previous=>[sample,...previous.filter(item=>item.id!==sample.id)].slice(0,10));}
    }catch(failure){if(alive.current&&!abort.signal.aborted)setError(failure instanceof Error?failure.message:'请求失败');}
    finally{if(alive.current){setBusy('');if(action==='connect')setCredentials(previous=>({...previous,password:''}));}running.current=false;}
  }
  return <div className="kd-overlay kd-config-overlay"><section className="kd-modal kd-prep-config kd-xingkong-config kd-module" role="dialog" aria-modal="true" aria-labelledby="kd-api-config-title">
    <header><div className="kd-module-heading"><span className="kd-module-icon">{isStock?<Boxes size={22}/>:<Database size={22}/>}</span><div><small>金蝶星空 / {isStock?'物料收发汇总':'销售出库汇总'}</small><h2 id="kd-api-config-title">{title}采集</h2></div></div><button aria-label={'关闭'+title+'采集'} onClick={onClose}><X size={20}/></button></header>
    <nav className="kd-module-tabs" aria-label={title+'模块'}>{([['configure','采集配置'],['records','采集记录'],['sample','20行探测']] as const).map(([key,label])=><button key={key} aria-current={panel===key?'page':undefined} onClick={()=>setPanel(key)}>{label}{key==='records'&&<span>{collections.length}</span>}</button>)}</nav>
    <div className="kd-module-content">
      {error&&<p className="kd-error" role="alert">{error}</p>}{loadError&&<p className="kd-error" role="alert">{loadError}</p>}
      {busy&&<p className="kd-progress" role="status"><LoaderCircle size={16} className="kd-spin"/>{busy==='connect'?'正在验证金蝶账号…':busy==='probe'?'正在读取前20行…':busy==='collect'?'正在创建全量采集任务…':busy==='cancel'?'正在停止采集…':'正在读取样本…'}</p>}
      {panel==='configure'&&<>
        <div className="kd-module-intro"><h3>{isStock?'先采集保存方案范围，再按名单归组':'按所选期间采集，汇总公司出库数量'}</h3><p>{isStock?'原始数据保留全部返回仓库。内仓、外仓分别统计，名单外仓库暂不计入公司结存。':'保留赠品与负数，剔除显示小计/总计，再执行六项客户排除。'}</p></div>
        <div className="kd-connection-layout"><section className="kd-config-block"><h3><Plug size={16}/>连接账号</h3><fieldset disabled={!!busy}>
          <label className="kd-xingkong-wide">账套ID<input autoComplete="off" value={credentials.accountId} maxLength={100} onChange={event=>updateCredentials('accountId',event.target.value)}/></label>
          <label>用户名<input autoComplete="off" maxLength={100} value={credentials.username} onChange={event=>updateCredentials('username',event.target.value)}/></label>
          <label>密码<input type="password" autoComplete="off" maxLength={1024} placeholder={session?'已连接，密码已清空':'填写金蝶登录密码'} value={credentials.password} onChange={event=>updateCredentials('password',event.target.value)}/></label>
        </fieldset><div className="kd-connection-state"><button disabled={!!busy||!credentials.accountId.trim()||!credentials.username.trim()||!credentials.password} onClick={()=>void run('connect')}>测试连接</button>{session?<span><CheckCircle2 size={14}/>已连接，有效至{time(session.expiresAt)}</span>:<small>密码仅用于登录，不保存。</small>}</div></section>
        <section className="kd-config-block"><h3>采集条件</h3><fieldset disabled={!!busy}>
          <label>{isStock?'预期开始日期':'销售开始日期'}<input type="date" value={settings.start} onChange={event=>setSettings(previous=>({...previous,start:event.target.value}))}/></label>
          <label>{isStock?'预期截止日期':'销售截止日期'}<input type="date" value={settings.end} onChange={event=>setSettings(previous=>({...previous,end:event.target.value}))}/></label>
          {isStock?<label className="kd-xingkong-wide">库存保存方案内码<input maxLength={128} value={settings.schemeId} onChange={event=>setSettings(previous=>({...previous,schemeId:event.target.value}))}/></label>:<><label>销售组织<input maxLength={100} value={settings.salesOrganization} onChange={event=>setSettings(previous=>({...previous,salesOrganization:event.target.value}))}/></label><label>结算组织<input maxLength={100} value={settings.settleOrganization} onChange={event=>setSettings(previous=>({...previous,settleOrganization:event.target.value}))}/></label></>}
        </fieldset><p className="kd-condition-note">{isStock?'实际日期、组织和仓库范围取自星空保存方案；这里的预期日期不会覆盖方案。需要全部仓库时，请先将星空方案保存为全部仓库。':'组织可填写编码或准确名称。全部单据状态、全部统计套件，包含赠品及服务物料。'}</p></section></div>
        {isStock?<KingdeeWarehouseScope rules={rules} onManage={onManageWarehouses}/>:<details className="kd-filter-details"><summary>{rules.companySales.excludeCustomerContains.length}项客户排除条件</summary><p>名称包含任意一项即排除，不区分大小写，原始业务数据仍保留。</p><ul>{rules.companySales.excludeCustomerContains.map(name=><li key={name}>{name}</li>)}</ul></details>}
        <div className="kd-module-run"><div><strong>准备好后开始全量采集</strong><p>任务在后台运行，关闭窗口不中断；服务器一次处理一个任务，最长45分钟。</p></div><div><button disabled={!!busy||!session||!valid} onClick={()=>void run('probe')}>先探测20行</button><button className="kd-primary" disabled={!!busy||!session||!valid||active} onClick={()=>void run('collect')}><Play size={15}/>开始{title}全量采集</button></div></div>
      </>}
      {panel==='records'&&<div className="kd-record-layout"><aside aria-label={title+'历史采集记录'}><h3><History size={16}/>{title}记录</h3>{collections.length?collections.map(job=><button key={job.id} aria-pressed={selected?.id===job.id} onClick={()=>setCollectionId(job.id)}><span>{time(job.createdAt)}</span><strong>{isStock?'方案 '+job.settings.schemeId:job.settings.start+' 至 '+job.settings.end}</strong><small className={'kd-job-state is-'+job.state}>{stateLabel[job.state]} · {count(job.progress.rawRows)}行</small></button>):<p>暂无{title}采集记录。<button onClick={()=>setPanel('configure')}>前往采集配置</button></p>}</aside>
        {selected&&<section className="kd-record-detail"><header><div><small>账套 {selected.accountId} · 规则 v{selected.rules.version}</small><h3>{selected.phase}</h3></div><span className={'kd-job-state is-'+selected.state}>{stateLabel[selected.state]}</span></header>
          <p>已读取 {count(selected.progress.rawRows)} / {selected.progress.reportedTotal===null?'待返回':count(selected.progress.reportedTotal)} 行，完成 {selected.progress.pages} 页</p>
          <progress aria-label={title+'采集进度'} max={Math.max(1,selected.progress.reportedTotal||1)} value={Math.min(selected.progress.rawRows,selected.progress.reportedTotal||0)}/>
          <div className="kd-record-metrics"><div><small>业务行</small><strong>{count(selected.progress.businessRows)}</strong></div><div><small>{isStock?'未计入仓库行':'客户排除行'}</small><strong>{count(isStock?selected.stock?.excludedRows||0:selected.progress.excludedCustomerRows)}</strong></div><div><small>{isStock?'内外仓结存':'计入出库数量'}{selected.state!=='ready'?'（当前已读）':''}</small><strong>{selected.progress.includedQuantity}</strong></div></div>
          {selected.stock&&<><div className="kd-stock-result-totals"><span>内仓结存 <strong>{selected.stock.inner}</strong></span><span>外仓结存 <strong>{selected.stock.outer}</strong></span></div><div className="kd-stock-warehouse-table"><table><caption>本次返回的仓库与归组（采集启动时规则）</caption><thead><tr><th>仓库编码</th><th>仓库名称</th><th>分组</th><th>结存数量</th><th>业务行</th></tr></thead><tbody>{selected.stock.warehouses.map(warehouse=><tr key={warehouse.code+'\0'+warehouse.name}><td>{warehouse.code}</td><td>{warehouse.name}</td><td>{warehouse.group==='inner'?'内仓':warehouse.group==='outer'?'外仓':'未计入'}</td><td>{warehouse.quantity}</td><td>{warehouse.rows}</td></tr>)}</tbody></table></div></>}
          <p className="kd-record-muted">剔除显示小计 {selected.progress.subtotalRows} 行、总计 {selected.progress.grandTotalRows} 行。</p>
          {selected.error&&<p className="kd-error" role="alert">{selected.error}</p>}
          {['running','cancelling'].includes(selected.state)&&<button disabled={!!busy||selected.state==='cancelling'} onClick={()=>void run('cancel',selected.id)}>停止采集</button>}
          {selected.state==='ready'&&<><div className="kd-collection-links">{([['source','业务原件 Excel'],['statistics',isStock?'内外仓汇总 JSON':'销量汇总 JSON'],['audit','核对记录']] as const).map(([format,name])=><a key={format} href={'/api/kingdee/xingkong/collections/'+selected.id+'?download='+format}><Download size={13}/>{name}</a>)}</div><button disabled={!!busy} className="kd-primary" onClick={()=>onUse(selected)}><CheckCircle2 size={15}/>采用这份{title}来源</button><details className="kd-filter-details"><summary>统计口径与核对说明</summary><ul>{selected.warnings.map(warning=><li key={warning}>{warning}</li>)}</ul></details></>}
        </section>}
      </div>}
      {panel==='sample'&&<section className="kd-sample-panel"><h3>{title}20行探测</h3><p>样本只供核对字段和条件，不用于生成明细。</p><div className="kd-sample-history">{history.map(item=><button disabled={!!busy} key={item.id} onClick={()=>void run('history',item.id)}>{time(item.createdAt)} · {item.returnedRows}/{count(item.total)}行</button>)}</div>{!history.length&&!probe&&<p>暂无本模块样本。连接账号后，可在采集配置中点击“先探测20行”。</p>}
        {probe&&<><div className="kd-sample-heading"><strong>返回{probe.returnedRows}行 / 接口总数{count(probe.total)}</strong><a href={'/api/kingdee/xingkong/probes/'+probe.id+'?download=1'}><Download size={13}/>下载样本 JSON</a></div><details className="kd-filter-details"><summary>实际请求与说明</summary><ul>{probe.warnings.map(warning=><li key={warning}>{warning}</li>)}</ul><pre>{JSON.stringify(probe.request,null,2)}</pre></details><div className="kd-xingkong-table"><table aria-label={title+'20行样本'}><thead><tr><th>行</th>{probe.columns.map(column=><th key={column.field}>{column.label}</th>)}</tr></thead><tbody>{probe.rows.map((row,index)=><tr key={index}><td>{index+1}</td>{probe.columns.map(column=><td key={column.field}>{row[column.field]==null?'（空）':String(row[column.field])}</td>)}</tr>)}</tbody></table></div></>}
      </section>}
    </div><footer><button onClick={onClose}><ArrowLeft size={15}/>返回数据准备</button><span>{title}记录独立保存 · 只有完整结果可用于生成明细</span></footer>
  </section></div>;
}