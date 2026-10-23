'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, FileSpreadsheet, LoaderCircle, X } from 'lucide-react';
import { assessPreparation, preparationChoices, type SourceMode } from '@/lib/kingdee-preparation';
import { KingdeeWarehouseScope } from './kingdee-warehouse-scope';
import { KingdeeXingkongProbe } from './kingdee-xingkong-probe';
import { KingdeeCollectionRun } from './kingdee-collection-run';
import { sourceKinds, sourceLabels, type KingdeeBatch, type SourceKind, type KingdeeRules } from '@/lib/kingdee-types';
import type { XingkongCollection } from '@/lib/kingdee-xingkong-types';

const time = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)}MB`;
const titles: Record<SourceKind, string> = { companySales: '公司销量', companyStock: '公司库存', storeSales: '门店销量', storeStock: '门店库存', prices: '结算价', legacy: '原明细底表（必须继承）', goods:'停止采购（吉客云）' };
const steps = ['准备数据', '核对来源', '生成明细'];

export function KingdeePreparation({ open, batch, history, rules, onClose, onGenerated, onManageWarehouses }: {
  open: boolean; batch: KingdeeBatch | null; history: KingdeeBatch[]; rules: KingdeeRules; onClose: () => void; onManageWarehouses: () => void; onGenerated: (batch: KingdeeBatch) => Promise<void>;
}) {
  const today = new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
  const [period,setPeriod]=useState({start:today.slice(0,7)+'-01',end:today.slice(0,7)+'-'+new Date(Number(today.slice(0,4)),Number(today.slice(5,7)),0).getDate(),stockDate:today});
  const [choices, setChoices] = useState(() => preparationChoices(batch));
  const [files, setFiles] = useState<Partial<Record<SourceKind, File>>>({}), [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [success, setSuccess] = useState<KingdeeBatch | null>(null), [revision, setRevision] = useState(0);
  const [configuration, setConfiguration] = useState(false), [refreshError, setRefreshError] = useState('');
  const [probeKind, setProbeKind] = useState<'companySales' | 'companyStock'>('companySales');
  const [unified,setUnified]=useState(false);
  const [collections,setCollections] = useState<XingkongCollection[]>([]);
  const [collectionError,setCollectionError] = useState('');
  const sending = useRef(false);
  const dialog = useRef<HTMLElement>(null);
  const readyHistory = history.filter(item => item.state === 'ready');
  const assessment = assessPreparation(choices, files, readyHistory, collections);
  useEffect(()=>{if(!open)return;const abort=new AbortController();fetch('/api/kingdee/xingkong/collections',{signal:abort.signal,cache:'no-store'}).then(async response=>{if(!response.ok)throw new Error();const result=await response.json() as {collections:XingkongCollection[]};setCollections(result.collections);setCollectionError('');}).catch(()=>{if(!abort.signal.aborted)setCollectionError('完整采集记录暂时未读取，请重新打开连接与采集窗口查看。');});return()=>abort.abort();},[open]);
  useEffect(() => {
    if (!open) return;
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { prior?.focus(); };
  }, [open]);
  useEffect(() => { if (configuration) document.getElementById('kd-api-config-title')?.closest('section')?.querySelector<HTMLButtonElement>('button')?.focus(); }, [configuration]);
  useEffect(() => { if (busy) dialog.current?.focus(); }, [busy]);
  function choose(kind: SourceKind, mode: SourceMode) { setChoices(previous => ({ ...previous, [kind]: { ...previous[kind], mode } })); setError(''); setSuccess(null); }
  function reset(preset: 'mixed' | 'upload' | 'saved') { setChoices(preparationChoices(batch, preset)); setError(''); setSuccess(null); setStep(0); }
  function closeConfiguration() { setConfiguration(false); setUnified(false); dialog.current?.querySelector<HTMLButtonElement>('button')?.focus(); }
  function close() { if (!sending.current) { closeConfiguration(); if (success) { setChoices(preparationChoices(success)); setSuccess(null); setStep(0); setError(''); } onClose(); } }
  async function generate(baselineOnly=false) {
    if (sending.current || (!baselineOnly && !assessment.ready) || (baselineOnly && !files.legacy)) return;
    sending.current = true; setBusy(true); setError(''); setRefreshError('');
    try {
      const data = new FormData();
      for (const kind of sourceKinds) if ((!baselineOnly || kind==='legacy') && choices[kind].mode === 'upload' && files[kind]) data.append(kind, files[kind]!);
      data.append('sourceReferences', JSON.stringify(baselineOnly?{}:assessment.references));
      data.append('collectionReferences',JSON.stringify(baselineOnly?{}:assessment.collectionReferences));
      const baseBatchId=choices.legacy.mode==='saved'?choices.legacy.batchId:batch?.sources.some(s=>s.kind==='legacy')?batch.id:undefined;
      data.append('inheritance',JSON.stringify(baselineOnly?{baselineOnly:true}:{baseBatchId,period}));
      const response = await fetch('/api/kingdee/imports', { method: 'POST', body: data });
      const result = await response.json() as { batch?: KingdeeBatch; error?: string };
      if (!response.ok || !result.batch) throw new Error(result.error || '生成失败，请稍后重试');
      const created = result.batch;
      setSuccess(created); setFiles({}); setRevision(value => value + 1); setChoices(preparationChoices(created, 'saved'));
      try { await onGenerated(created); } catch { setRefreshError('明细已保存，工作台暂时未刷新。可重新载入页面查看，无需再次生成。'); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : '生成失败'); }
    finally { sending.current = false; setBusy(false); }
  }
  if (!open) return null;
  return <div className="kd-overlay kd-preparation-overlay"><section ref={dialog} tabIndex={-1} className="kd-modal kd-preparation" role="dialog" aria-modal="true" aria-labelledby="kd-preparation-title" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); if (configuration) closeConfiguration(); else close(); }
    if (event.key !== 'Tab') return;
    const scope = configuration ? document.querySelector('#kd-api-config-title')?.closest('section') : dialog.current;
    const focusable = [...(scope?.querySelectorAll<HTMLElement>('button,a[href],input,select,summary,[tabindex="0"]') || [])].filter(element => !element.matches(':disabled') && element.offsetParent !== null);
    if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <header><div><h2 id="kd-preparation-title">准备金蝶数据</h2><p>星空在线采集 · 星辰Excel上传 · 按选定来源生成明细</p></div><button aria-label="关闭数据准备" disabled={busy} onClick={close}><X size={19}/></button></header>
    <nav className="kd-prep-steps" aria-label="数据准备步骤">{steps.map((label, index) => <button key={label} disabled={busy || !!success} aria-current={step === index ? 'step' : undefined} onClick={() => setStep(index)}><span>{success || index < step ? <Check size={13}/> : index + 1}</span>{label}</button>)}</nav>
    <div className="kd-prep-content">
      {error && <p className="kd-error" role="alert">{error}。文件选择仍保留，旧成功报表未被覆盖。</p>}
      {success ? <section className="kd-prep-success" aria-label="明细生成完成"><span><Check size={27}/></span><h3>本批明细已生成</h3><p>{success.summary.goods.toLocaleString('zh-CN')}个商品 · 规则v{success.rules.version} · {time(success.createdAt)}</p><p>来源原件、版本和计算结果已保存，可返回工作台查看或导出。</p>{refreshError && <p role="alert">{refreshError}</p>}<a href={'/api/kingdee/export?batch=' + success.id}>导出本批Excel</a></section> : <>
        {step === 0 && <>
          <div className="kd-prep-presets"><span>准备方式</span><button disabled={busy} onClick={() => reset('mixed')}>星空采集＋星辰上传</button><button disabled={busy} onClick={() => reset('upload')}>全部上传Excel</button>{batch && <button disabled={busy} onClick={() => reset('saved')}>沿用当前批次来源</button>}</div>
          <p className="kd-prep-hint">星空销量、库存、价目表与吉客云停止采购可统一启动，后台顺序执行并分别留存记录；星辰两份报表继续上传。</p>
          <button className="kd-primary" disabled={busy} onClick={()=>{setUnified(true);setConfiguration(true);}}>统一采集在线来源</button>
          {collectionError && <p className="kd-error">{collectionError}</p>}
          <div className="kd-prep-dates"><label>销量开始<input type="date" value={period.start} onChange={e=>setPeriod(p=>({...p,start:e.target.value}))}/></label><label>销量结束<input type="date" value={period.end} onChange={e=>setPeriod(p=>({...p,end:e.target.value}))}/></label><label>库存列标注日期<input type="date" value={period.stockDate} onChange={e=>setPeriod(p=>({...p,stockDate:e.target.value}))}/></label><p>日期用于新增列标题，请核对两套系统各自的实际来源条件；标注日期不会改写来源日期。相同期间与标注日期更新末尾七列，其他期间继续向右追加。</p></div>
          <div className="kd-prep-source-list">{assessment.rows.map((row, index) => {
            const available = readyHistory.filter(item => item.sources.some(source => source.kind === row.kind));
            const company = ['companySales','companyStock','prices','goods'].includes(row.kind);
            return <article key={row.kind} className={"kd-prep-source"+(company?" kd-prep-online":"")}><header><span className="kd-source-index">{index + 1}</span><div><h3>{titles[row.kind]}</h3><p>{sourceLabels[row.kind]}</p></div><span className={'kd-prep-state ' + (row.ready ? 'is-ready' : 'is-pending')}>{row.status}</span></header>
              <div className="kd-source-mode" role="group" aria-label={titles[row.kind] + '获取方式'}>{company && <button disabled={busy} aria-pressed={row.mode === 'api'} onClick={() => choose(row.kind, 'api')}>在线采集</button>}<button disabled={busy} aria-pressed={row.mode === 'upload'} onClick={() => choose(row.kind, 'upload')}>上传Excel</button><button disabled={busy || !available.length} aria-pressed={row.mode === 'saved'} onClick={() => choose(row.kind, 'saved')}>选已保存版本</button>{(row.kind === 'goods') && <button disabled={busy} aria-pressed={row.mode === 'omit'} onClick={() => choose(row.kind, 'omit')}>本批不使用</button>}</div>
              {row.mode === 'api' ? <div className="kd-api-pending">{row.collection ? <><p className="kd-source-selected">{row.name}</p><p>{row.collection.progress.businessRows.toLocaleString('zh-CN')}行业务原件 · {row.kind==='companySales'?'出库数量 '+row.collection.progress.includedQuantity:row.kind==='companyStock'?'内外仓结存 '+row.collection.progress.includedQuantity:'完整属性来源'}</p><small>采集于{time(row.collection.createdAt)}，生成时按当前规则重算。</small></> : <p>{row.kind==='companySales'?'按日期和组织采集，执行六项客户排除。':row.kind==='companyStock'?'读取保存方案范围，保留全部返回仓库，按内外仓名单汇总结存。':row.kind==='goods'?'读取吉客云最新停止采购，显示是/否；未知或冲突留空。':'按组织和价目表编号获取价格分录，状态、整单状态、失效均为全部。'}</p>}<button disabled={busy} onClick={() => { setProbeKind(row.kind === 'companyStock' ? 'companyStock' : 'companySales'); setUnified(row.kind==='prices'||row.kind==='goods'); setConfiguration(true); }}>{row.kind==='companySales'?'进入销量采集':row.kind==='companyStock'?'进入库存采集':'进入统一采集'}<ChevronRight size={14}/></button></div>
                : row.mode === 'upload' ? <label className="kd-prep-file"><FileSpreadsheet size={18}/><span>{files[row.kind]?.name || '选择原始导出的.xlsx文件'}</span><input key={revision + row.kind} aria-label={'上传' + sourceLabels[row.kind]} type="file" accept=".xlsx" disabled={busy} onChange={event => { setFiles(previous => ({ ...previous, [row.kind]: event.target.files?.[0] })); setError(''); }}/>{row.name && <small>{size(row.size)}</small>}</label>
                : row.mode === 'saved' ? <><label className="kd-saved-choice">选择来源版本<select aria-label={titles[row.kind] + '来源版本'} value={choices[row.kind].batchId} disabled={busy} onChange={event => setChoices(previous => ({ ...previous, [row.kind]: { ...previous[row.kind], batchId: event.target.value } }))}><option value="">请选择</option>{available.map(item => <option key={item.id} value={item.id}>{time(item.createdAt)} · {item.sources.find(source => source.kind === row.kind)!.name}</option>)}</select></label>{row.source && <p className="kd-source-note">原件 {row.source.rows.toLocaleString('zh-CN')}行 · {size(row.size)} · 沿用所选批次文件，本次不会重新采集。</p>}</>
                : <p className="kd-source-note">{row.kind === 'goods' ? '不提供吉客云货品属性时，停止采购留空，采集并采用货品来源后显示是/否。' : '必须提供原明细底表；已有版本可以直接继承。'}</p>}
              {row.kind==='legacy' && row.mode==='upload' && <><p className="kd-source-note">首次可只上传目标Excel，完整载入原明细；之后选择已保存底表继续追加。原文件不修改。</p><button disabled={busy||!files.legacy} onClick={()=>void generate(true)}>仅载入原明细，不追加采集列</button></>}
              {row.kind==='companyStock' &&<KingdeeWarehouseScope rules={rules} onManage={()=>{closeConfiguration();onClose();onManageWarehouses();}}/>}
              {row.issue && row.mode !== 'api' && (row.mode !== 'upload' || row.name) && <p className="kd-prep-field-error">{row.issue}</p>}
            </article>;
          })}</div>
        </>}
        {step === 1 && <section className="kd-prep-review"><h3>核对本批来源</h3><p>生成时只使用下列文件或版本。沿用版本不会刷新ERP，也不会按旧日期冒充新采集。</p>{assessment.rows.map(row => <article key={row.kind}><header><strong>{titles[row.kind]}</strong><span>{row.status}</span></header><p>{row.name || (row.mode === 'omit' ? '本批不使用' : '尚未准备')}</p>{row.batch && <small>来源批次：{time(row.batch.createdAt)} · {row.source!.rows.toLocaleString('zh-CN')}行</small>}{row.collection&&<small>采集于{time(row.collection.createdAt)} · {row.collection.kind==='companyStock'?'库存按保存方案日期，预期日期不覆盖方案':row.collection.settings.start+' 至 '+row.collection.settings.end} · 生成时使用当前规则</small>}{row.mode === 'upload' && row.name && <small>{size(row.size)} · 提交后核验表头、业务行及合计</small>}{row.source?.conditions && <details><summary>查看该文件原导出条件</summary><p>{row.source.conditions}</p></details>}{row.issue && <p className="kd-prep-field-error">{row.issue}</p>}</article>)}<p>仓库分组采用当前保存版本。历史年月、统一时点、门店差异、缺价及新分类继续按已约定暂缓，保留来源说明。</p></section>}
        {step === 2 && <section className="kd-prep-generate"><h3>生成本批明细</h3><p>{assessment.readyCount}/{assessment.requiredCount}项来源已准备 · 原件合计{size(assessment.size)}</p>{assessment.issues.length ? <div className="kd-prep-blockers"><strong>仍需准备</strong><ul>{assessment.issues.map(issue => <li key={issue}>{issue}</li>)}</ul><button onClick={() => setStep(0)}>返回准备数据</button></div> : <><p>继承原明细的行号、历史数据和格式，在CJ后追加本期七列，价格与金额顺延；新物料追加末尾。旧批次保留。</p><p>生成包含文件核验与分析，请等待真实完成结果。</p></>}{busy && <p className="kd-progress" role="status"><LoaderCircle className="kd-spin" size={17}/>正在上传、核验和计算，请勿关闭此窗口。旧成功结果仍保留。</p>}</section>}
      </>}
    </div>
    <footer className="kd-prep-footer"><span>{success ? '已完成' : `必要来源 ${assessment.readyCount}/${assessment.requiredCount} · 单份≤32MB，合计≤50MB`}</span><div>{success ? <><button onClick={() => { setSuccess(null); reset('mixed'); }}>继续准备下一批</button><button className="kd-primary" onClick={() => refreshError ? window.location.reload() : close()}>{refreshError ? '重新载入工作台' : '查看明细'}</button></> : <>{step > 0 && <button disabled={busy} onClick={() => setStep(step - 1)}><ChevronLeft size={14}/>上一步</button>}{step < 2 ? <button className="kd-primary" disabled={busy} onClick={() => setStep(step + 1)}>{step === 0 ? '核对来源' : '进入生成'}<ChevronRight size={14}/></button> : <button className="kd-primary" disabled={busy || !assessment.ready} onClick={() => void generate()}>{busy ? '生成中…' : '生成明细'}</button>}</>}</div></footer>
    {configuration && !unified && <KingdeeXingkongProbe key={probeKind} initialKind={probeKind} rules={rules} onManageWarehouses={()=>{closeConfiguration();onClose();onManageWarehouses();}} onUse={collection=>{setCollections(previous=>[collection,...previous.filter(job=>job.id!==collection.id)]);setChoices(previous=>({...previous,[collection.kind]:{mode:'api',batchId:'',collectionId:collection.id}}));setCollectionError('');closeConfiguration();}} onClose={closeConfiguration}/>}
    {configuration && unified && <KingdeeCollectionRun onUse={jobs=>{setCollections(previous=>[...jobs,...previous.filter(old=>!jobs.some(job=>job.id===old.id))]);setChoices(previous=>{const next={...previous};for(const job of jobs)next[job.kind]={mode:'api',batchId:'',collectionId:job.id};return next;});closeConfiguration();}} onClose={closeConfiguration}/>}
  </section></div>;
}
