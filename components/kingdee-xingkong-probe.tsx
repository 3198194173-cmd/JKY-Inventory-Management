'use client';
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import { xingkongBaseUrl, type XingkongCollection, type XingkongKind, type XingkongProbe } from '@/lib/kingdee-xingkong-types';

type SavedProbe = Pick<XingkongProbe, 'id' | 'createdAt' | 'kind' | 'returnedRows' | 'total'>;
const label = (kind: XingkongKind) => kind === 'companySales' ? '公司销量' : '公司库存';
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
export function KingdeeXingkongProbe({ initialKind, customerExclusions, onUse, onClose }: { initialKind: XingkongKind; customerExclusions: string[]; onUse: (collection:XingkongCollection)=>void; onClose: () => void }) {
  const [kind, setKind] = useState<XingkongKind>(initialKind);
  const [credentials, setCredentials] = useState({ accountId: '20200417192138569', username: '', password: '' });
  const [settings, setSettings] = useState({ start: '', end: '', salesOrganization: '103', settleOrganization: '103', schemeId: '6ad1c8d85e3e71' });
  const [session, setSession] = useState<{ token: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [probe, setProbe] = useState<XingkongProbe | null>(null);
  const [history, setHistory] = useState<SavedProbe[]>([]), [historyError, setHistoryError] = useState('');
  const [collections,setCollections] = useState<XingkongCollection[]>([]),[collectionId,setCollectionId]=useState(''),[collectionError,setCollectionError]=useState('');
  const selectedCollection=collections.find(job=>job.id===collectionId)||collections[0];
  const activeCollection=collections.find(job=>job.state==='running'||job.state==='cancelling');
  const controller = useRef<AbortController | null>(null), sessionToken = useRef(''), running = useRef(false), alive = useRef(true);
  function dropConnection() {
    controller.current?.abort();
    const token = sessionToken.current; sessionToken.current = '';
    if (token) void fetch('/api/kingdee/xingkong/connection', { method: 'DELETE', headers: { 'X-Kingdee-Session': token }, keepalive: true }).catch(() => {});
  }
  useEffect(() => {
    alive.current = true;
    const abort = new AbortController();
    fetch('/api/kingdee/xingkong/probes', { signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error('历史探测记录暂时不可用');
      const data = await response.json() as { probes: SavedProbe[] }; if (alive.current) setHistory(data.probes);
    }).catch(error => { if (alive.current && error.name !== 'AbortError') setHistoryError('历史探测记录暂时不可用，可稍后重新打开查看。'); });
    return () => { alive.current = false; abort.abort(); dropConnection(); };
  }, []);
  useEffect(()=>{
    const abort=new AbortController();
    const load=()=>fetch('/api/kingdee/xingkong/collections',{signal:abort.signal,cache:'no-store'}).then(async response=>{if(!response.ok)throw new Error();const data=await response.json() as {collections:XingkongCollection[]};if(alive.current){setCollections(previous=>data.collections.map(job=>{const old=previous.find(item=>item.id===job.id);return old&&old.updatedAt>job.updatedAt?old:job;}));setCollectionError('');}}).catch(()=>{if(alive.current&&!abort.signal.aborted)setCollectionError('采集记录暂时读取失败。后台任务不因此取消，稍后刷新或重新打开查看。');});
    void load();const timer=setInterval(()=>void load(),5000);return()=>{abort.abort();clearInterval(timer);};
  },[]);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(() => { dropConnection(); setSession(null); setError('连接已过期，请重新测试连接。'); }, Math.max(0, Date.parse(session.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [session]);
  function updateCredentials(key: keyof typeof credentials, value: string) {
    if (sessionToken.current) { dropConnection(); setSession(null); }
    setCredentials(previous => ({ ...previous, [key]: value })); setError(''); setProbe(null);
  }
  async function run(action: 'connect' | 'probe' | 'history' | 'collect' | 'cancel', savedId?: string) {
    if (running.current) return;
    running.current = true; setBusy(action); setError(''); setProbe(null);
    const abort = new AbortController(); controller.current = abort;
    try {
      const path = action === 'connect' ? '/api/kingdee/xingkong/connection' : action === 'probe' ? '/api/kingdee/xingkong/probes' : action==='collect'?'/api/kingdee/xingkong/collections':action==='cancel'?'/api/kingdee/xingkong/collections/'+savedId+'/cancel':'/api/kingdee/xingkong/probes/' + savedId;
      const response = await fetch(path, { method: action === 'history' ? 'GET' : 'POST', signal: abort.signal,
        headers: { 'Content-Type': 'application/json', ...(['probe','collect'].includes(action) ? { 'X-Kingdee-Session': sessionToken.current } : {}) },
        ...(action === 'history' ? {} : { body: JSON.stringify(action === 'connect' ? credentials : action==='cancel'?{}:{ kind, ...settings }) }) });
      const result = await response.json() as XingkongProbe & { error?: string; token: string; expiresAt: string; probe: XingkongProbe; collection:XingkongCollection };
      if (!response.ok) {
        if (['probe','collect'].includes(action) && response.status === 401) { dropConnection(); setSession(null); }
        throw new Error(result.error || '请求失败，请稍后重试');
      }
      if (!alive.current) {
        if (action === 'connect' && result.token) void fetch('/api/kingdee/xingkong/connection', { method: 'DELETE', headers: { 'X-Kingdee-Session': result.token }, keepalive: true }).catch(() => {});
        return;
      }
      if (action === 'connect') { sessionToken.current = result.token; setSession({ token: result.token, expiresAt: result.expiresAt }); }
      else if (action==='collect'||action==='cancel') {
        setCollections(previous=>[result.collection,...previous.filter(job=>job.id!==result.collection.id)]);setCollectionId(result.collection.id);
        if(action==='collect'){sessionToken.current='';setSession(null);}
      }
      else {
        const sample = (action === 'history' ? result : result.probe) as XingkongProbe; setProbe(sample);
        if (action === 'probe') setHistory(previous => [sample, ...previous.filter(item => item.id !== sample.id)].slice(0, 10));
      }
    } catch (failure) { if (alive.current && !abort.signal.aborted) setError(failure instanceof Error ? failure.message : '请求失败'); }
    finally {
      if (alive.current) { setBusy(''); if (action === 'connect') setCredentials(previous => ({ ...previous, password: '' })); }
      running.current = false;
    }
  }
  return <div className="kd-overlay kd-config-overlay"><section className="kd-modal kd-prep-config kd-xingkong-config" role="dialog" aria-modal="true" aria-labelledby="kd-api-config-title">
    <header><h2 id="kd-api-config-title">星空连接与正式销售采集</h2><button aria-label="关闭星空采集配置" onClick={onClose}><X size={18}/></button></header>
    <p>服务地址：{xingkongBaseUrl}。销售支持后台全量分页，库存先探测或上传Excel；全部为只读查询。</p>
    <p>密码仅用于登录，不落库。普通连接保留15分钟；开始正式采集后连接交给后台任务，最多45分钟，关闭网页不中断。任务结束后如需再次查询须重新登录。</p>
    <fieldset disabled={!!busy}>
      <label>账套ID<input autoComplete="off" maxLength={100} value={credentials.accountId} onChange={event => updateCredentials('accountId', event.target.value)}/></label>
      <label>用户名<input autoComplete="off" maxLength={100} value={credentials.username} onChange={event => updateCredentials('username', event.target.value)}/></label>
      <label>密码<input type="password" autoComplete="off" maxLength={1024} placeholder={session ? '已连接，密码未保留' : '填写金蝶登录密码'} value={credentials.password} onChange={event => updateCredentials('password', event.target.value)}/></label>
      <div className="kd-xingkong-login"><button onClick={() => void run('connect')} disabled={!credentials.accountId.trim() || !credentials.username.trim() || !credentials.password}>{busy === 'connect' ? '正在登录…' : '测试连接'}</button></div>
    </fieldset>
    {session && <p className="kd-xingkong-connected" role="status">账号登录通过 · 有效至{time(session.expiresAt)}。报表权限及条件需继续探测核对。</p>}
    <fieldset disabled={!!busy}>
      <label>探测报表<select aria-label="探测报表" value={kind} onChange={event => { setKind(event.target.value as XingkongKind); setError(''); setProbe(null); }}><option value="companySales">公司销量 · 销售出库汇总</option><option value="companyStock">公司库存 · 物料收发汇总</option></select></label>
      <span/>
      <label>{kind === 'companySales' ? '销售开始日期' : '预期库存开始日期'}<input type="date" value={settings.start} onChange={event => setSettings(previous => ({ ...previous, start: event.target.value }))}/></label>
      <label>{kind === 'companySales' ? '销售截止日期' : '预期库存截止日期'}<input type="date" value={settings.end} onChange={event => setSettings(previous => ({ ...previous, end: event.target.value }))}/></label>
      {kind === 'companySales' ? <>
        <label>销售组织（编码或准确名称）<input maxLength={100} value={settings.salesOrganization} onChange={event => setSettings(previous => ({ ...previous, salesOrganization: event.target.value }))}/></label>
        <label>结算组织（编码或准确名称）<input maxLength={100} value={settings.settleOrganization} onChange={event => setSettings(previous => ({ ...previous, settleOrganization: event.target.value }))}/></label>
      </> : <label className="kd-xingkong-wide">库存过滤方案内码 FSCHEMEID<input maxLength={128} value={settings.schemeId} onChange={event => setSettings(previous => ({ ...previous, schemeId: event.target.value }))}/><small>预填的是2026-10-16实测方案“API物料收发汇总”的内码，请核对当前用户可见性及方案条件。不能填写方案名称。</small></label>}
    </fieldset>
    <p>{kind === 'companySales' ? '销售条件：全部单据状态、全部统计套件、包含赠品及服务物料。先查询实际组织内码，再发送所选日期。六客户排除按当前仓库账户规则标注，不删除原始样本。' : '库存接口完全使用金蝶保存方案。此处日期只是待核对的预期值，不会覆盖方案日期；先在星空中检查并保存日期、组织和仓库范围。'}</p>
    {kind==='companySales'&&<details className="kd-xingkong-history"><summary>正式统计的{customerExclusions.length}项客户排除条件</summary><p>客户名称包含下列任意一项就不计入正式销量，匹配不区分大小写。原始业务记录保留；赠品不额外筛除，负数参与汇总。</p><ul>{customerExclusions.map(name=><li key={name}>{name}</li>)}</ul><p>这是客户条件，销售接口没有仓库字段。</p></details>}
    {error && <p className="kd-error" role="alert">{error}</p>}
    {busy && <p className="kd-progress" role="status"><LoaderCircle className="kd-spin" size={16}/>{busy === 'connect' ? '正在请求金蝶登录服务，不会自动重试密码…' : busy === 'probe' ? '正在查询首页最多20行，请等待真实返回…' :busy==='collect'?'正在创建后台任务…':busy==='cancel'?'正在请求停止…':'正在读取已保存样本…'}</p>}
    <div className="kd-xingkong-actions"><button disabled={!!busy || !session || !settings.start || !settings.end || (kind === 'companySales' ? !settings.salesOrganization.trim() || !settings.settleOrganization.trim() : !settings.schemeId.trim())} className="kd-primary" onClick={() => void run('probe')}>探测{label(kind)}20行</button><span>样本不会计入五项来源就绪状态，明细仍使用Excel或完整历史版本。</span></div>
    {kind==='companySales'&&<div className="kd-xingkong-actions"><button disabled={!!busy||!session||!!activeCollection||!settings.start||!settings.end||!settings.salesOrganization.trim()||!settings.settleOrganization.trim()} className="kd-primary" onClick={()=>void run('collect')}>开始正式销售采集</button><span>完成全部分页，排除小计/总计和指定客户后生成销量；关闭此窗口不中断。一次运行一个任务。</span></div>}
    {collectionError&&<p className="kd-error" role="alert">{collectionError}</p>}
    {!!collections.length&&<section className="kd-xingkong-result" aria-label="正式销售采集记录"><h3>正式销售采集</h3><label>采集任务<select value={selectedCollection?.id||''} onChange={event=>setCollectionId(event.target.value)}>{collections.map(job=><option key={job.id} value={job.id}>{time(job.createdAt)} · {job.settings.start}至{job.settings.end} · {job.phase}</option>)}</select></label>{selectedCollection&&<>
      <p>账套{selectedCollection.accountId} · 规则v{selectedCollection.rules.version} · {selectedCollection.phase}</p>
      <p>已接收{selectedCollection.progress.rawRows.toLocaleString('zh-CN')} / {selectedCollection.progress.reportedTotal?.toLocaleString('zh-CN')??'等待接口返回'}条原始行 · {selectedCollection.progress.pages}页</p>
      {(selectedCollection.state==='running'||selectedCollection.state==='cancelling')&&<><progress max={Math.max(1,selectedCollection.progress.reportedTotal||1)} value={Math.min(selectedCollection.progress.rawRows,selectedCollection.progress.reportedTotal||0)}/><button disabled={!!busy||selectedCollection.state==='cancelling'} onClick={()=>void run('cancel',selectedCollection.id)}>停止采集</button></>}
      <table className="kd-collection-counts"><tbody><tr><th>业务行</th><td>{selectedCollection.progress.businessRows}</td><th>小计 / 总计</th><td>{selectedCollection.progress.subtotalRows} / {selectedCollection.progress.grandTotalRows}</td></tr><tr><th>客户排除行</th><td>{selectedCollection.progress.excludedCustomerRows}</td><th>计入业务行</th><td>{selectedCollection.progress.includedRows}</td></tr><tr><th>{selectedCollection.state==='ready'?'正式出库数量':'当前已读出库数量'}</th><td colSpan={3}>{selectedCollection.progress.includedQuantity}</td></tr></tbody></table>
      {selectedCollection.error&&<p className="kd-error" role="alert">{selectedCollection.error}</p>}
      {selectedCollection.state==='ready'&&<><ul>{selectedCollection.warnings.map(warning=><li key={warning}>{warning}</li>)}</ul><div className="kd-collection-links"><a href={'/api/kingdee/xingkong/collections/'+selectedCollection.id+'?download=source'}>完整业务原件Excel（客户排除前）</a><a href={'/api/kingdee/xingkong/collections/'+selectedCollection.id+'?download=statistics'}>正式销量汇总JSON（已排除）</a><a href={'/api/kingdee/xingkong/collections/'+selectedCollection.id+'?download=audit'}>采集核对记录</a></div><button disabled={!!busy} className="kd-primary" onClick={()=>onUse(selectedCollection)}>采用这份公司销量来源</button></>}
    </>}</section>}
    {probe && <section className="kd-xingkong-result" aria-label="星空探测结果">
      <h3>{label(probe.kind)}探测记录 · 仅样本</h3><p>账套{probe.accountId} · {time(probe.createdAt)} · 返回{probe.returnedRows}行 / 接口总数{probe.total.toLocaleString('zh-CN')} · {(probe.durationMs / 1000).toFixed(2)}秒{probe.kind === 'companyStock' ? ` · ${probe.queryIdReceived ? '已返回' : '未返回'}CurQueryId` : ''}</p>
      {!!probe.organizations.length && <p>核验销售组织：{probe.organizations[0].name}（{probe.organizations[0].code} / {probe.organizations[0].id}）；结算组织：{probe.organizations[1].name}（{probe.organizations[1].code} / {probe.organizations[1].id}）</p>}
      <ul>{probe.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
      <a href={'/api/kingdee/xingkong/probes/' + probe.id + '?download=1'}>下载本次样本JSON</a>
      <details><summary>查看实际接口和请求条件</summary><p>{probe.endpoint}</p>{probe.kind === 'companySales' && <p>本次本地客户排除名单（仅标注）：{probe.customerExclusions.length ? probe.customerExclusions.join('；') : '无'}</p>}<pre>{JSON.stringify(probe.request, null, 2)}</pre></details>
      {!!probe.rows.length && <div className="kd-xingkong-table"><table aria-label="星空前20行原始样本"><thead><tr><th>样本行</th><th>标注</th>{probe.columns.map(column => <th key={column.field} title={column.field}>{column.label}</th>)}</tr></thead><tbody>{probe.rows.map((row, index) => <tr key={index}><td>{index + 1}</td><td>{probe.rowNotes[index]?.displayTotal ? '显示汇总，勿重复累计' : probe.rowNotes[index]?.excludedCustomer ? '命中当前客户排除名单' : '待页面核对'}</td>{probe.columns.map(column => <td key={column.field}>{row[column.field] == null ? '（空）' : String(row[column.field])}</td>)}</tr>)}</tbody></table></div>}
    </section>}
    {!!history.length && <details className="kd-xingkong-history"><summary>最近探测记录（当前账户）</summary>{history.map(item => <button disabled={!!busy} key={item.id} onClick={() => void run('history', item.id)}>{time(item.createdAt)} · {label(item.kind)} · {item.returnedRows}/{item.total}行</button>)}</details>}
    {historyError && <p>{historyError}</p>}
    <footer><button onClick={onClose}>返回数据准备</button><span>完整采集成功后可采用来源，其他必要报表继续上传或复用。</span></footer>
  </section></div>;
}
