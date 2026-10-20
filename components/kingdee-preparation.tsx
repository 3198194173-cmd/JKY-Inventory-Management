'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, FileSpreadsheet, LoaderCircle, X } from 'lucide-react';
import { assessPreparation, preparationChoices, type SourceMode } from '@/lib/kingdee-preparation';
import { sourceKinds, sourceLabels, type KingdeeBatch, type SourceKind } from '@/lib/kingdee-types';

const time = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)}MB`;
const titles: Record<SourceKind, string> = { companySales: '公司销量', companyStock: '公司库存', storeSales: '门店销量', storeStock: '门店库存', prices: '结算价', legacy: '旧明细资料（可选）' };
const steps = ['准备数据', '核对来源', '生成明细'];

export function KingdeePreparation({ open, batch, history, onClose, onGenerated }: {
  open: boolean; batch: KingdeeBatch | null; history: KingdeeBatch[]; onClose: () => void; onGenerated: (batch: KingdeeBatch) => Promise<void>;
}) {
  const [choices, setChoices] = useState(() => preparationChoices(batch));
  const [files, setFiles] = useState<Partial<Record<SourceKind, File>>>({}), [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [success, setSuccess] = useState<KingdeeBatch | null>(null), [revision, setRevision] = useState(0);
  const [configuration, setConfiguration] = useState(false), [refreshError, setRefreshError] = useState('');
  const [connection, setConnection] = useState({ accountId: '', username: '', password: '', start: '', end: '', salesOrganization: '', settleOrganization: '', scheme: '' });
  const sending = useRef(false);
  const dialog = useRef<HTMLElement>(null);
  const readyHistory = history.filter(item => item.state === 'ready');
  const assessment = assessPreparation(choices, files, readyHistory);
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
  function closeConfiguration() { setConnection(previous => ({ ...previous, password: '' })); setConfiguration(false); dialog.current?.querySelector<HTMLButtonElement>('button')?.focus(); }
  function close() { if (!sending.current) { closeConfiguration(); if (success) { setChoices(preparationChoices(success)); setSuccess(null); setStep(0); setError(''); } onClose(); } }
  async function generate() {
    if (sending.current || !assessment.ready) return;
    sending.current = true; setBusy(true); setError(''); setRefreshError('');
    try {
      const data = new FormData();
      for (const kind of sourceKinds) if (choices[kind].mode === 'upload' && files[kind]) data.append(kind, files[kind]!);
      data.append('sourceReferences', JSON.stringify(assessment.references));
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
          <p className="kd-prep-hint">接口采集待联调。当前可以上传Excel，或明确选择已保存版本走完生成流程；选文件后仍需服务端核验，不代表已采集成功。</p>
          <div className="kd-prep-source-list">{assessment.rows.map((row, index) => {
            const available = readyHistory.filter(item => item.sources.some(source => source.kind === row.kind));
            const company = row.kind === 'companySales' || row.kind === 'companyStock';
            return <article key={row.kind} className="kd-prep-source"><header><span className="kd-source-index">{index + 1}</span><div><h3>{titles[row.kind]}</h3><p>{sourceLabels[row.kind]}</p></div><span className={'kd-prep-state ' + (row.ready ? 'is-ready' : 'is-pending')}>{row.status}</span></header>
              <div className="kd-source-mode" role="group" aria-label={titles[row.kind] + '获取方式'}>{company && <button disabled={busy} aria-pressed={row.mode === 'api'} onClick={() => choose(row.kind, 'api')}>接口采集 · 待联调</button>}<button disabled={busy} aria-pressed={row.mode === 'upload'} onClick={() => choose(row.kind, 'upload')}>上传Excel</button><button disabled={busy || !available.length} aria-pressed={row.mode === 'saved'} onClick={() => choose(row.kind, 'saved')}>选已保存版本</button>{row.kind === 'legacy' && <button disabled={busy} aria-pressed={row.mode === 'omit'} onClick={() => choose('legacy', 'omit')}>本批不使用</button>}</div>
              {row.mode === 'api' ? <div className="kd-api-pending"><p>尚未连接网页采集服务。接通后将在这里显示连接状态、分页进度和失败原因。</p><button disabled={busy} onClick={() => setConfiguration(true)}>查看星空采集配置</button><button disabled>开始采集（待联调）</button></div>
                : row.mode === 'upload' ? <label className="kd-prep-file"><FileSpreadsheet size={18}/><span>{files[row.kind]?.name || '选择原始导出的.xlsx文件'}</span><input key={revision + row.kind} aria-label={'上传' + sourceLabels[row.kind]} type="file" accept=".xlsx" disabled={busy} onChange={event => { setFiles(previous => ({ ...previous, [row.kind]: event.target.files?.[0] })); setError(''); }}/>{row.name && <small>{size(row.size)}</small>}</label>
                : row.mode === 'saved' ? <><label className="kd-saved-choice">选择来源版本<select aria-label={titles[row.kind] + '来源版本'} value={choices[row.kind].batchId} disabled={busy} onChange={event => setChoices(previous => ({ ...previous, [row.kind]: { ...previous[row.kind], batchId: event.target.value } }))}><option value="">请选择</option>{available.map(item => <option key={item.id} value={item.id}>{time(item.createdAt)} · {item.sources.find(source => source.kind === row.kind)!.name}</option>)}</select></label>{row.source && <p className="kd-source-note">原件 {row.source.rows.toLocaleString('zh-CN')}行 · {size(row.size)} · 沿用所选批次文件，本次不会重新采集。</p>}</>
                : <p className="kd-source-note">不提供旧明细时，历史缓存和旧分类可能为空，新业务商品仍保留。</p>}
              {row.issue && row.mode !== 'api' && (row.mode !== 'upload' || row.name) && <p className="kd-prep-field-error">{row.issue}</p>}
            </article>;
          })}</div>
        </>}
        {step === 1 && <section className="kd-prep-review"><h3>核对本批来源</h3><p>生成时只使用下列文件或版本。沿用版本不会刷新ERP，也不会按旧日期冒充新采集。</p>{assessment.rows.map(row => <article key={row.kind}><header><strong>{titles[row.kind]}</strong><span>{row.status}</span></header><p>{row.name || (row.mode === 'omit' ? '本批不使用' : '尚未准备')}</p>{row.batch && <small>来源批次：{time(row.batch.createdAt)} · {row.source!.rows.toLocaleString('zh-CN')}行</small>}{row.mode === 'upload' && row.name && <small>{size(row.size)} · 提交后核验表头、业务行及合计</small>}{row.source?.conditions && <details><summary>查看该文件原导出条件</summary><p>{row.source.conditions}</p></details>}{row.issue && <p className="kd-prep-field-error">{row.issue}</p>}</article>)}<p>仓库分组采用当前保存版本。历史年月、统一时点、门店差异、缺价及新分类继续按已约定暂缓，保留来源说明。</p></section>}
        {step === 2 && <section className="kd-prep-generate"><h3>生成本批明细</h3><p>{assessment.readyCount}/5项必要来源已准备 · 原件合计{size(assessment.size)}</p>{assessment.issues.length ? <div className="kd-prep-blockers"><strong>仍需准备</strong><ul>{assessment.issues.map(issue => <li key={issue}>{issue}</li>)}</ul><button onClick={() => setStep(0)}>返回准备数据</button></div> : <><p>按所选来源生成新的92列明细。旧批次保留；空白、负数及内外仓规则沿用当前实现。</p><p>生成包含文件核验与分析，请等待真实完成结果。</p></>}{busy && <p className="kd-progress" role="status"><LoaderCircle className="kd-spin" size={17}/>正在上传、核验和计算，请勿关闭此窗口。旧成功结果仍保留。</p>}</section>}
      </>}
    </div>
    <footer className="kd-prep-footer"><span>{success ? '已完成' : `必要来源 ${assessment.readyCount}/5 · 单份≤32MB，合计≤50MB`}</span><div>{success ? <><button onClick={() => { setSuccess(null); reset('mixed'); }}>继续准备下一批</button><button className="kd-primary" onClick={() => refreshError ? window.location.reload() : close()}>{refreshError ? '重新载入工作台' : '查看明细'}</button></> : <>{step > 0 && <button disabled={busy} onClick={() => setStep(step - 1)}><ChevronLeft size={14}/>上一步</button>}{step < 2 ? <button className="kd-primary" disabled={busy} onClick={() => setStep(step + 1)}>{step === 0 ? '核对来源' : '进入生成'}<ChevronRight size={14}/></button> : <button className="kd-primary" disabled={busy || !assessment.ready} onClick={() => void generate()}>{busy ? '生成中…' : '生成明细'}</button>}</>}</div></footer>
    {configuration && <div className="kd-overlay kd-config-overlay"><section className="kd-modal kd-prep-config" role="dialog" aria-modal="true" aria-labelledby="kd-api-config-title"><header><h2 id="kd-api-config-title">星空采集配置</h2><button aria-label="关闭星空采集配置" onClick={closeConfiguration}><X size={18}/></button></header><p>可先填写本页配置，当前不会提交或请求ERP。接口待联调，填写不代表连接成功；密码关闭窗口即清空。</p><fieldset><label>账套ID<input placeholder="填写星空账套ID" autoComplete="off" maxLength={100} value={connection.accountId} onChange={event => setConnection(previous => ({ ...previous, accountId: event.target.value }))}/></label><label>用户名<input placeholder="填写金蝶用户名" autoComplete="off" maxLength={100} value={connection.username} onChange={event => setConnection(previous => ({ ...previous, username: event.target.value }))}/></label><label>密码<input type="password" placeholder="仅在当前配置窗口临时填写" autoComplete="off" maxLength={1024} value={connection.password} onChange={event => setConnection(previous => ({ ...previous, password: event.target.value }))}/></label><label>销售开始日期<input type="date" value={connection.start} onChange={event => setConnection(previous => ({ ...previous, start: event.target.value }))}/></label><label>销售截止日期<input type="date" value={connection.end} onChange={event => setConnection(previous => ({ ...previous, end: event.target.value }))}/></label><label>销售组织<input placeholder="接通后核验组织及权限" value={connection.salesOrganization} onChange={event => setConnection(previous => ({ ...previous, salesOrganization: event.target.value }))}/></label><label>结算组织<input placeholder="接通后核验组织及权限" value={connection.settleOrganization} onChange={event => setConnection(previous => ({ ...previous, settleOrganization: event.target.value }))}/></label><label>库存过滤方案<input placeholder="填写方案名称，接通后核验实际条件" value={connection.scheme} onChange={event => setConnection(previous => ({ ...previous, scheme: event.target.value }))}/></label></fieldset><p>库存日期以实际方案条件为准；不会把前端显示日期当作已生效的接口条件。</p><footer><button onClick={closeConfiguration}>返回数据准备</button><button disabled>测试连接（待联调）</button></footer></section></div>}
  </section></div>;
}
