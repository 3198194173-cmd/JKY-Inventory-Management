'use client';
import { useState } from 'react';
import { ArrowDownToLine, ChevronLeft, ChevronRight, FolderInput, LoaderCircle, Plus, RefreshCw, Search, Settings2, X } from 'lucide-react';
import type { kingdeeView } from '@/lib/kingdee-store';
import { sourceLabels, type SourceKind, type KingdeeGoods, type WarehouseMember } from '@/lib/kingdee-types';
import { defaultKingdeeTemplate, sheetColumns, type SheetMode } from '@/lib/kingdee-sheet';
import { KingdeeExcelGrid } from './kingdee-excel-grid';
import { KingdeePreparation } from './kingdee-preparation';

type View = ReturnType<typeof kingdeeView>;
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
async function json<T>(response: Response): Promise<T> {
  const data = await response.json() as T & { error?: string }; if (!response.ok) throw new Error(data.error || '请求失败，请重试'); return data;
}

export function KingdeeDashboard({ initial }: { initial: View }) {
  const [view, setView] = useState(initial), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [uploadOpen, setUploadOpen] = useState(!initial.batch), [warehouseOpen, setWarehouseOpen] = useState(false);
  const [members, setMembers] = useState<WarehouseMember[]>(structuredClone(initial.rules.warehouses.members));
  const [q, setQ] = useState(''), [filter, setFilter] = useState('all'), [selected, setSelected] = useState<KingdeeGoods | null>(null);
  const [mode, setMode] = useState<SheetMode>('current'), [column, setColumn] = useState(''), [contains, setContains] = useState(''), [direction, setDirection] = useState(''), [columnOpen, setColumnOpen] = useState(false);
  const [draftColumn, setDraftColumn] = useState(''), [draftContains, setDraftContains] = useState(''), [draftDirection, setDraftDirection] = useState('');
  async function reload(page = 1, batch = view.batch?.id || '', override: Record<string, string> = {}) {
    const params = new URLSearchParams({ q, filter, sheet: mode, column, contains, direction, page: String(page), ...override }); if (batch) params.set('batch', batch);
    const data = await json<View>(await fetch('/api/kingdee?' + params, { cache: 'no-store' })); setView(data);
  }
  async function action(label: string, perform: () => Promise<void>) {
    setBusy(label); setError(''); try { await perform(); } catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败'); } finally { setBusy(''); }
  }
  function recalculate() {
    void action('正在按当前仓库分组重算…', async () => {
      const { batch } = await json<{ batch: { id: string } }>(await fetch('/api/kingdee/recalculate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batch: view.batch?.id }) }));
      await reload(1, batch.id);
    });
  }
  const summary = view.batch?.summary;
  const template = view.batch?.template || defaultKingdeeTemplate;
  const innerCount = view.rules.warehouses.members.filter(row => row.group === 'inner').length, outerCount = view.rules.warehouses.members.filter(row => row.group === 'outer').length;
  return <section className="kd-dashboard" aria-label="金蝶存销明细工作台">
    <div className="kd-toolbar"><h1>casebang 存销明细</h1><div className="kd-actions"><button disabled={!!busy} onClick={() => { setMembers(structuredClone(view.rules.warehouses.members)); setWarehouseOpen(true); }}><Settings2 size={15}/>仓库分组</button><button disabled={!!busy} onClick={() => setUploadOpen(true)}><FolderInput size={15}/>准备数据</button>{view.batch && <a href={'/api/kingdee/export?batch=' + view.batch.id + '&sheet=' + mode}><ArrowDownToLine size={15}/>导出Excel</a>}</div></div>
    {error && <p className="kd-error" role="alert">{error}。上次成功结果仍保留。</p>}
    {busy && <p className="kd-progress" role="status"><LoaderCircle size={17} className="kd-spin"/>{busy}</p>}
    <KingdeePreparation open={uploadOpen} batch={view.batch} history={view.history} onClose={() => setUploadOpen(false)} onGenerated={async batch => {
      await reload(1, batch.id, { q: '', filter: 'all', sheet: 'current', column: '', contains: '', direction: '' });
      setQ(''); setFilter('all'); setMode('current'); setColumn(''); setContains(''); setDirection(''); setSelected(null); setColumnOpen(false);
    }}/>
    {!summary ? <section className="kd-empty"><FolderInput size={35}/><h2>先导入你的金蝶报表</h2><p>仓库分组已按本次名单预置：{innerCount}个内仓、{outerCount}个外仓，可随时调整。</p><p>不需要先补齐暂缓项，即可查看当前数据和缺失情况。</p></section> : <>
      <div className="kd-version"><label>数据批次<select disabled={!!busy} value={view.batch!.id} onChange={event => void action('读取批次…', () => reload(1, event.target.value))}>{view.history.filter(row => row.state === 'ready').map(row => <option key={row.id} value={row.id}>{time(row.createdAt)} · {row.summary.goods}个商品</option>)}</select></label><span>规则 v{view.batch!.rules.version} · {view.batch!.rules.warehouses.members.filter(row => row.group === 'inner').length}内仓 / {view.batch!.rules.warehouses.members.filter(row => row.group === 'outer').length}外仓</span><button disabled={!!busy} onClick={recalculate}><RefreshCw size={14}/>按当前分组重算</button></div>
      {view.rulesChanged && <p className="kd-notice" role="status">仓库分组已更新，当前批次仍使用原分组。点击“按当前分组重算”生成新版本，旧结果保留。</p>}
      <details className="kd-details"><summary>来源与暂缓事项 · 点击查看各表条件和未纳入仓库</summary><ul>{summary.notices.map(note => <li key={note}>{note}</li>)}</ul><div className="kd-source-grid">{view.batch!.sources.map(source => <article key={source.kind}><strong>{sourceLabels[source.kind]}</strong><p>{source.name}</p><small>{source.rows}行业务数据{source.total !== null ? ' · 源合计 ' + source.total : ''}</small><p>{source.conditions || '源文件没有条件摘要'}</p></article>)}</div><p>未纳入当前名单：{summary.warehouses.filter(row => row.group === 'outside' || row.group === 'excluded').map(row => row.name).join('、') || '无'}</p></details>
      <form className="kd-search" onSubmit={event => { event.preventDefault(); void action('查询中…', () => reload()); }}><label><Search size={15}/><input value={q} onChange={event => setQ(event.target.value)} placeholder="搜索物料编码 / 名称" aria-label="搜索金蝶物料"/></label><select aria-label="筛选异常" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部商品</option><option value="missing">本批缺结算价</option><option value="conflict">本批价格冲突</option><option value="unclassified">四维资料待补</option></select><button disabled={!!busy} type="submit">查询</button>{column && <button type="button" onClick={() => { setColumn(''); setContains(''); setDirection(''); void action('清除列筛选…', () => reload(1, view.batch!.id, { column: '', contains: '', direction: '' })); }}>清除{column}列筛选 / 排序</button>}<span>本批公司结存 {summary.totals.companyStock} · 门店结存 {summary.totals.storeStock} · 缺价 {summary.missingPrices}</span></form>
      {columnOpen && <form className="kd-column-filter" onSubmit={event => { event.preventDefault(); setColumnOpen(false); void action('筛选整张表…', async () => { await reload(1, view.batch!.id, { column: draftColumn, contains: draftContains, direction: draftDirection }); setColumn(draftColumn); setContains(draftContains); setDirection(draftDirection); }); }}><strong>{draftColumn}列 · {sheetColumns(template, mode).find(item => item.key === draftColumn)?.label}</strong><input aria-label="列内容包含" value={draftContains} onChange={event => setDraftContains(event.target.value)} placeholder="内容包含（整张表）"/><select aria-label="列排序" value={draftDirection} onChange={event => setDraftDirection(event.target.value)}><option value="">原表顺序</option><option value="asc">升序</option><option value="desc">降序</option></select><button disabled={!!busy} type="submit">应用</button><button type="button" onClick={() => setColumnOpen(false)}>关闭</button></form>}
      <KingdeeExcelGrid rows={view.rows} template={template} mode={mode} busy={!!busy} activeColumn={column} onSource={setSelected} onColumn={key => { setDraftColumn(key); setDraftContains(key === column ? contains : ''); setDraftDirection(key === column ? direction : ''); setColumnOpen(true); }} onMode={next => { setColumnOpen(false); void action('切换工作表…', async () => { await reload(1, view.batch!.id, { sheet: next, column: '', contains: '', direction: '' }); setColumn(''); setContains(''); setDirection(''); setMode(next); }); }}/>
      <div className="kd-pagination"><span>共{view.totalRows.toLocaleString('zh-CN')}个商品 · 每页{view.pageSize}条</span><div><button aria-label="上一页" disabled={!!busy || view.page <= 1} onClick={() => void action('读取上一页…', () => reload(view.page - 1))}><ChevronLeft size={16}/></button><span>第{view.page} / {Math.max(1, Math.ceil(view.totalRows / view.pageSize))}页</span><button aria-label="下一页" disabled={!!busy || view.page * view.pageSize >= view.totalRows} onClick={() => void action('读取下一页…', () => reload(view.page + 1))}><ChevronRight size={16}/></button></div></div>
    </>}
    {!!view.history.find(batch => batch.state === 'failed') && <details className="kd-details"><summary>导入失败记录（不影响成功批次）</summary>{view.history.filter(batch => batch.state === 'failed').map(batch => <p key={batch.id}>{time(batch.createdAt)} · {batch.error}</p>)}</details>}
    {warehouseOpen && <div className="kd-overlay"><section className="kd-modal" role="dialog" aria-modal="true" aria-labelledby="kd-warehouse-title"><header><h2 id="kd-warehouse-title">内外仓分组</h2><button aria-label="关闭仓库分组" onClick={() => setWarehouseOpen(false)}><X size={20}/></button></header><p>按仓库名称精确匹配。名单外仓库不计入本次公司结存，可添加后重算。</p><div className="kd-warehouse-list">{members.map((member, index) => <div key={index}><input aria-label={`仓库名称${index + 1}`} list="kd-known-warehouses" value={member.name} onChange={event => setMembers(previous => previous.map((item, i) => i === index ? { ...item, name: event.target.value } : item))}/><select aria-label={`仓库归属${index + 1}`} value={member.group} onChange={event => setMembers(previous => previous.map((item, i) => i === index ? { ...item, group: event.target.value as WarehouseMember['group'] } : item))}><option value="inner">内仓</option><option value="outer">外仓</option><option value="excluded">排除</option></select><button aria-label={`移除仓库${index + 1}`} onClick={() => setMembers(previous => previous.filter((_, i) => i !== index))}><X size={15}/></button></div>)}</div><datalist id="kd-known-warehouses">{summary?.warehouses.map(row => <option key={row.name} value={row.name}/>)}</datalist><footer><button onClick={() => setMembers(previous => [...previous, { name: '', group: 'inner' }])}><Plus size={16}/>添加仓库</button><button className="kd-primary" disabled={!!busy} onClick={() => void action('保存仓库分组…', async () => { await json(await fetch('/api/kingdee/warehouses', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ members }) })); await reload(); setWarehouseOpen(false); })}>保存分组</button></footer></section></div>}
    {selected && <div className="kd-overlay"><section className="kd-modal" role="dialog" aria-modal="true" aria-labelledby="kd-source-title"><header><h2 id="kd-source-title">{selected.code}</h2><button aria-label="关闭来源" onClick={() => setSelected(null)}><X size={20}/></button></header><p>{selected.name}</p>{Object.entries(selected.sources).map(([kind, rows]) => <p key={kind}><strong>{sourceLabels[kind as SourceKind]}</strong><br/>{view.batch!.sources.find(source => source.kind === kind)?.name}<br/>源行：{rows.join('、')}{rows.length === 100 ? '（仅展示前100条）' : ''}</p>)}<p>{mode === 'original' ? '正在查看原Excel历史缓存值。' : '历史G—CC取原表缓存值，CD—CN取本批计算。'}分类空白保留；本批新价不覆盖原表价格。</p></section></div>}
  </section>;
}
