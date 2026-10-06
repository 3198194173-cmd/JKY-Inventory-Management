"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDownToLine, ArrowDownUp, ArrowLeft, ArrowRight, BellRing, CircleHelp, Clock3, LoaderCircle, Plus, RefreshCw, Search, Warehouse } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Pagination } from "@/components/ui/pagination";
import type { InventoryView, RunInfo, WarehouseInfo } from "@/lib/inventory-types";
import type { AlertSettings } from "@/lib/alerts-store";
import type { InventoryMetrics } from "@/lib/inventory-metrics";
import { compareQuantity } from "@/lib/decimal";
import { SalesCalendar } from "@/components/sales-calendar";

const quantity = (value: string) => { const [a,b] = value.split("."); return a.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (b ? "." + b : ""); };
const time = (value: string) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
function MetricValue({ metrics, field }: { metrics?: InventoryMetrics; field: "average7" | "turnoverDays" }) {
  const value = metrics?.[field];
  if (value != null) return <strong title="全部可比较日期按仓库区间核验入库；仍为库存消耗估算，其他库存变动可能影响结果">{quantity(value)}</strong>;
  const reason = metrics?.reason;
  const label = reason === "inbound_unverified" ? "待核验入库" : reason === "no_consumption" ? "无消耗" : reason === "negative_inventory" ? "库存为负" : "不足7天";
  return <span className="compact-metric-empty" title={reason === "insufficient_data" || !metrics ? `最近7天仅有 ${metrics?.validDays || 0} 天可计算；缺日、缺货品或单位变化不补零` : label}><span className="compact-muted">—</span><small>{label}</small></span>;
}
function hasInbound(row: InventoryView["rows"][number], date: string) {
  const correction=row.inbound?.[date];
  return !!correction && (correction.records.some(r=>compareQuantity(r.quantity,"0")>0) || (correction.inboundQuantity != null && compareQuantity(correction.inboundQuantity,"0")>0));
}
function SalesValue({ row, date }: { row: InventoryView["rows"][number]; date: string }) {
  const correction = row.inbound?.[date], value = row.sales?.[date];
  const pending = row.rawSales?.[date] != null && value == null;
  return <span className="compact-sales-value" title={correction?.error || (pending ? "该采集区间入库未核验；点击货品查看详情" : correction?.status === "verified" ? `原始差额 ${correction.rawDifference} + 入库 ${correction.inboundQuantity}；点击查看单据` : "库存差额估算")}>{value == null ? "—" : quantity(value)}{pending && <small className="compact-sales-note">待核验</small>}</span>;
}
async function apiJson<T>(response: Response): Promise<T> {
  const raw = await response.text();
  let data: { error?: string };
  try { data = JSON.parse(raw) as { error?: string }; }
  catch { throw new Error(`服务返回了非数据页面（HTTP ${response.status}）。请查看采集记录确认结果，稍后重试。`); }
  if (!response.ok) throw new Error(data.error || "请求失败，请重试");
  return data as T;
}
function Sparkline({ dates, values }: { dates: string[]; values: Record<string, string | null> }) {
  const points = [...dates].reverse().map(date => ({ date, n: values[date] == null ? null : Number(values[date]) }));
  const present = points.flatMap(p => p.n !== null && Number.isFinite(p.n) ? [p.n] : []);
  if (!present.length) return <span className="compact-muted">—</span>;
  const low = Math.min(...present), range = Math.max(...present) - low || 1;
  const xy = (n: number, i: number) => [5 + i / Math.max(1,points.length - 1) * 124, 29 - (n - low) / range * 24];
  let path = "", previous = "";
  points.forEach(({ date, n }, i) => {
    if (n === null || !Number.isFinite(n)) { previous = ""; return; }
    const contiguous = previous && new Date(date + "T00:00:00Z").getTime() - new Date(previous + "T00:00:00Z").getTime() === 86_400_000;
    const [x,y] = xy(n, i); path += `${contiguous ? "L" : "M"}${x},${y} `; previous = date;
  });
  return <svg width="134" height="34" viewBox="0 0 134 34" role="img" aria-label={`${present.length} 天销售库存差额趋势`}><path d="M5 30H129" stroke="#e5eaf3" strokeDasharray="3 3"/><path d={path} fill="none" stroke="#4371eb" strokeWidth="1.7"/>{points.map((p,i) => p.n === null || !Number.isFinite(p.n) ? null : <circle key={p.date} cx={xy(p.n,i)[0]} cy={xy(p.n,i)[1]} r={present.length === 1 ? 3 : 1.7} fill="#4371eb"/>)}</svg>;
}
export default function InventoryDashboard({ initial }: { initial: InventoryView }) {
  const router = useRouter();
  const [view,setView] = useState(initial), [code,setCode] = useState(initial.warehouseCode);
  const [warehouses,setWarehouses] = useState(initial.warehouses || []);
  const [search,setSearch] = useState(""), [query,setQuery] = useState(""), [days,setDays] = useState("14"), [page,setPage] = useState(1), [pageSize,setPageSize] = useState("100"), [sort,setSort] = useState("code");
  const [sortDate,setSortDate] = useState("");
  const [refresh,setRefresh] = useState(0), [loading,setLoading] = useState(false), [syncing,setSyncing] = useState(false), [exporting,setExporting] = useState(false);
  const [notice,setNotice] = useState(""), [error,setError] = useState("");
  const [addOpen,setAddOpen] = useState(false), [newCode,setNewCode] = useState(""), [newName,setNewName] = useState(""), [savingWarehouse,setSavingWarehouse] = useState(false);
  const [help,setHelp] = useState(false), [recordsOpen,setRecordsOpen] = useState(false), [runs,setRuns] = useState<RunInfo[]>([]), [alertsOpen,setAlertsOpen] = useState(false);
  const [unavailableOpen,setUnavailableOpen] = useState(false);
  const [selected,setSelected] = useState<InventoryView["rows"][number] | null>(null);
  const [alerts,setAlerts] = useState<AlertSettings>({ enabled:false, threshold:"0", lastSentAt:null, lastResult:null, robotConfigured:initial.robotConfigured });
  const [threshold,setThreshold] = useState("0"), [enabled,setEnabled] = useState(false), [saving,setSaving] = useState(false);
  const skipInitialLoad = useRef(true), previousRun = useRef<RunInfo | null>(null);
  const dates = view.salesDates || [], active = warehouses.find(w => w.code === code), latestRun = runs[0], running = syncing || (latestRun?.status === "running" || latestRun?.status === "queued");
  function receiveRuns(next: RunInfo[]) {
    const before = previousRun.current, latest = next[0];
    previousRun.current = latest || null; setRuns(next);
    if (!before || before.id !== latest?.id || !["running","queued"].includes(before.status) || ["running","queued"].includes(latest.status)) return;
    if (latest.status === "complete") { setError(""); setNotice(latest.message || "采集完成"); setRefresh(r => r + 1); }
    if (latest.status === "failed") { setNotice(""); setError(latest.message || "采集失败，上次成功数据已保留"); }
  }
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setPage(1); },300); return () => clearTimeout(timer); },[search]);
  useEffect(() => {
    if (skipInitialLoad.current) { skipInitialLoad.current = false; return; }
    const controller = new AbortController(); setLoading(true);
    fetch(`/api/inventory?${new URLSearchParams({ warehouseCode:code, q:query, days, page:String(page), pageSize, sort, sortDate })}`, { signal:controller.signal })
      .then(r => apiJson<InventoryView>(r)).then(d => { setView(d); setWarehouses(d.warehouses || []); setError(""); })
      .catch(e => { if (e.name !== "AbortError") setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  },[code,query,days,page,pageSize,sort,sortDate,refresh]);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/sync?${new URLSearchParams({warehouseCode:code})}`, {signal:controller.signal}).then(r => apiJson<{runs:RunInfo[]}>(r)).then(d => receiveRuns(d.runs)).catch(e => { if(e.name !== "AbortError") setError(e.message); });
    return () => controller.abort();
  },[recordsOpen,code,refresh]);
  useEffect(() => {
    if (!running) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      try {
        const result = await apiJson<{runs:RunInfo[]}>(await fetch(`/api/sync?${new URLSearchParams({warehouseCode:code})}`));
        if (!stopped) receiveRuns(result.runs);
      } catch { /* A transient status request must not erase the last known result. */ }
    }, 3000);
    return () => { stopped = true; window.clearInterval(timer); };
  },[code,running]);
  useEffect(() => {
    if (!alertsOpen) return;
    fetch("/api/alerts").then(r => apiJson<AlertSettings>(r)).then(d => { setAlerts(d); setThreshold(d.threshold); setEnabled(d.enabled); }).catch(e => setError(e.message));
  },[alertsOpen]);
  useEffect(() => {
    const modelContext = (document as Document & { modelContext?: { registerTool: (tool: unknown, options: {signal:AbortSignal}) => unknown } }).modelContext;
    if (!modelContext?.registerTool) return;
    const lifecycle = new AbortController();
    try { void Promise.resolve(modelContext.registerTool({ name:"inspect_inventory", title:"查询仓库库存", description:"读取当前仓库库存与已计算的每日销售库存差额；不采集、不发送消息。", inputSchema:{ type:"object", properties:{query:{type:"string",maxLength:100}}, additionalProperties:false }, annotations:{readOnlyHint:true,untrustedContentHint:true}, async execute(input:unknown) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("参数须为对象");
      const value = input as Record<string,unknown>;
      if (Object.keys(value).some(k => k !== "query") || (value.query !== undefined && (typeof value.query !== "string" || value.query.length > 100))) throw new Error("筛选参数无效");
      return apiJson<InventoryView>(await fetch(`/api/inventory?${new URLSearchParams({warehouseCode:code,q:String(value.query||"")})}`));
    } }, {signal:lifecycle.signal})).catch(() => {}); } catch { /* Visible controls work without WebMCP. */ }
    return () => lifecycle.abort();
  },[code]);
  function changeWarehouse(next: string) {
    if (next === code) return;
    setCode(next); if (sort.startsWith("sales_")) { setSort("code"); setSortDate(""); } setPage(1); setSearch(""); setQuery(""); setSelected(null); setNotice(""); setError(""); setRuns([]); previousRun.current = null;
    setUnavailableOpen(false); setView(v => ({ ...v, warehouseCode:next, snapshot:null, rows:[], snapshots:[], salesDates:[], unavailableSkus:[], totalRows:0 }));
  }
  async function add() {
    setSavingWarehouse(true); setError("");
    try {
      const list = await apiJson<WarehouseInfo[]>(await fetch("/api/warehouses", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:newCode.trim(),name:newName})}));
      setWarehouses(list); changeWarehouse(newCode.trim()); setAddOpen(false); setNewCode(""); setNewName(""); setNotice("仓库已保存。点击采集库存即可自动获取 SKU；服务器启用定时任务后，每天 08:00 自动采集。");
    } catch(e) { setError(e instanceof Error ? e.message : "仓库保存失败"); } finally { setSavingWarehouse(false); }
  }
  async function sync() {
    setSyncing(true); setError(""); setNotice("正在读取 SKU 目录。采集进度会显示在页面上，请勿重复提交。");
    try {
      const result = await apiJson<{queued?:boolean;goodsCount:number;skuCount:number;recordCount:number;unavailableCount:number;message?:string}>(await fetch("/api/sync", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({warehouseCode:code})}));
      if (result.queued) { setNotice("已加入后台采集队列，关闭网页也会继续执行。"); setRefresh(r => r + 1); return; }
      setNotice(result.message || `采集完成：已核验 ${result.recordCount.toLocaleString()} / ${result.skuCount.toLocaleString()} 个 SKU，${result.goodsCount.toLocaleString()} 个货品。${result.unavailableCount ? ` ${result.unavailableCount} 个 SKU 未取得库存，查看下方清单。` : ""}`); setRefresh(r => r + 1);
    } catch(e) {
      try {
        const status = await apiJson<{runs:RunInfo[]}>(await fetch(`/api/sync?${new URLSearchParams({warehouseCode:code})}`));
        receiveRuns(status.runs);
        const run = status.runs[0];
        if ((run?.status === "running" || run?.status === "queued")) setNotice(`${run.message || "采集中"}。网页连接已中断，仍在核对服务器状态；请勿重复提交。`);
        else if (run?.status === "complete" && Date.now() - new Date(run.startedAt).getTime() < 5 * 60_000) { setNotice(run.message || "采集完成"); setRefresh(r => r + 1); }
        else { setNotice(""); setError(run?.status === "failed" ? run.message || "采集失败，上次成功数据已保留" : e instanceof Error ? e.message : "采集结果暂时无法确认，请查看采集记录"); }
      } catch { setNotice(""); setError("连接暂时中断，请打开采集记录确认结果；上次成功库存仍保留。"); }
    } finally { setSyncing(false); }
  }
  async function download() {
    setExporting(true); setError("");
    try {
      const response = await fetch(`/api/export?${new URLSearchParams({warehouseCode:code})}`);
      if (!response.ok) await apiJson(response);
      const url = URL.createObjectURL(await response.blob()), link = document.createElement("a"); link.href = url; link.download = `${code}_${view.snapshot?.date}.xlsx`; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
    } catch(e) { setError(e instanceof Error ? e.message : "导出失败"); } finally { setExporting(false); }
  }
  async function saveAlerts() {
    setSaving(true); setError("");
    try { const result = await apiJson<AlertSettings>(await fetch("/api/alerts", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled,threshold})})); setAlerts(result); setNotice("预警设置已保存"); setAlertsOpen(false); } catch(e) { setError(e instanceof Error ? e.message : "保存失败"); } finally { setSaving(false); }
  }
  function sortSales(date: string) {
    setSortDate(date); setSort(sortDate === date && sort === "sales_desc" ? "sales_asc" : "sales_desc"); setPage(1);
  }
  const salesSortLabel = sort.startsWith("sales_") ? sortDate.slice(5) + (sort === "sales_desc" ? "销量从大到小" : "销量从小到大") : "";
  const totalPages = Math.max(1,Math.ceil(view.totalRows / view.pageSize));
  return <main className="compact-app">
    <header className="compact-header"><div className="compact-brand"><span className="compact-logo"><Warehouse size={22}/></span><h1>仓库数据</h1><span className="compact-subtitle">库存与销售</span></div><nav aria-label="辅助功能"><Button variant="ghost" onClick={async()=>{try{await apiJson(await fetch("/api/session",{method:"DELETE"}));router.replace("/login");}catch(e){setError(e instanceof Error ? e.message : "退出失败");}}}>退出</Button><Button variant="ghost" onClick={() => setRecordsOpen(true)}><Clock3/>采集记录</Button><Button variant="ghost" onClick={() => setAlertsOpen(true)}><BellRing/>预警</Button><Button variant="ghost" size="icon" aria-label="数据口径与自动采集说明" onClick={() => setHelp(true)}><CircleHelp/></Button></nav></header>
    <section className="compact-panel" aria-label="仓库库存与销售分析">
      <div className="compact-toolbar">
        <div className="compact-warehouse"><Select value={code} onValueChange={v => v && changeWarehouse(v)} disabled={running}><SelectTrigger aria-label="选择仓库"><SelectValue>{code} · {active?.name || code}</SelectValue></SelectTrigger><SelectContent>{warehouses.map(w => <SelectItem key={w.code} value={w.code}>{w.code} · {w.name}</SelectItem>)}</SelectContent></Select><Button variant="outline" size="icon" aria-label="增加仓库" onClick={() => { setError(""); setAddOpen(true); }} disabled={running}><Plus/></Button></div>
        <div className="compact-search"><Search size={16}/><Input aria-label="搜索货品编码或名称" placeholder="搜索编码 / 名称" value={search} onChange={e => setSearch(e.target.value)}/></div>
        <Select value={sort} onValueChange={v => { if(v) { setSort(v); setPage(1); } }}><SelectTrigger className="compact-sort" aria-label="排序方式"><ArrowDownUp size={15}/><SelectValue>{sort === "quantity_desc" ? "库存从大到小" : sort === "quantity_asc" ? "库存从小到大" : salesSortLabel || "编码排序"}</SelectValue></SelectTrigger><SelectContent><SelectItem value="code">编码排序</SelectItem><SelectItem value="quantity_desc">库存从大到小</SelectItem><SelectItem value="quantity_asc">库存从小到大</SelectItem>{dates.includes(sortDate) && <><SelectItem value="sales_desc">{sortDate.slice(5)}销量从大到小</SelectItem><SelectItem value="sales_asc">{sortDate.slice(5)}销量从小到大</SelectItem></>}</SelectContent></Select>
        <Select value={days} onValueChange={v => { if(v) { setDays(v); if (sort.startsWith("sales_")) { setSort("code"); setSortDate(""); } setPage(1); } }}><SelectTrigger className="compact-days" aria-label="销售日期范围"><SelectValue>近 {days} 天</SelectValue></SelectTrigger><SelectContent><SelectItem value="7">近 7 天</SelectItem><SelectItem value="14">近 14 天</SelectItem><SelectItem value="30">近 30 天</SelectItem></SelectContent></Select>
        <div className="compact-actions"><Button variant="outline" onClick={download} disabled={exporting || !view.snapshot || loading}>{exporting ? <LoaderCircle className="animate-spin"/> : <ArrowDownToLine/>}导出 Excel</Button><Button onClick={sync} disabled={running || !view.configured || loading}>{running ? <LoaderCircle className="animate-spin"/> : <RefreshCw/>}{running ? "采集中" : "采集库存"}</Button></div>
      </div>
      <div className="compact-status"><span>{view.snapshot ? `更新于 ${time(view.snapshot.capturedAt)}` : "暂无完整采集"}{loading && <LoaderCircle size={13} className="animate-spin"/>}</span><button type="button" onClick={() => setHelp(true)}>每天 08:00 · {view.scheduleActive ? "云端定时已启用" : "云端定时未运行"}</button></div>
      {(latestRun?.status === "running" || latestRun?.status === "queued") && <p className="compact-feedback" role="status"><LoaderCircle size={14} className="animate-spin"/> {latestRun.message || "正在采集"} · 已处理 {latestRun.pageCount} 页。采集中可查看最近已保存的库存，入库核验结束后自动刷新统计。</p>}
      {latestRun?.status === "failed" && !error && <p className="compact-feedback compact-error" role="alert">最近一次采集失败：{latestRun.message || "请重试"}。当前展示上次成功库存。</p>}
      {error && !addOpen && <p className="compact-feedback compact-error" role="alert">{error}</p>}{notice && <p className="compact-feedback" role="status">{notice}</p>}
      {!!view.unavailableSkus?.length && <div className="compact-feedback" role="status"><span>{view.unavailableSkus.length.toLocaleString()} 个 SKU 未取得可购库存，未计入库存及销售差额。</span><Button variant="link" onClick={() => setUnavailableOpen(true)}>查看未取得库存清单</Button></div>}
      <div className="compact-table-wrap" aria-busy={loading}>
        <Table className="compact-table" style={{minWidth: `${1032 + dates.length * 92}px`}}><TableHeader><TableRow><TableHead className="compact-index">#</TableHead><TableHead className="compact-goods">货品编码 / 名称</TableHead><TableHead className="compact-current"><button type="button" onClick={() => { setSort(sort === "quantity_desc" ? "quantity_asc" : "quantity_desc"); setPage(1); }}>当前库存 {sort === "quantity_desc" ? "↓" : sort === "quantity_asc" ? "↑" : "↕"}</button></TableHead><TableHead className="compact-metric" title="最近7个完整日期的消耗估算总和÷7；所有可比较日期按实际入库量修正">均值<span>近7天 · 估算</span></TableHead><TableHead className="compact-trend">销售趋势</TableHead>{dates.map(date => <TableHead key={date} className="compact-date" aria-sort={sortDate === date && sort.startsWith("sales_") ? sort === "sales_desc" ? "descending" : "ascending" : "none"}><button type="button" className="compact-sales-sort" onClick={() => sortSales(date)} aria-label={`${date}销量，点击按${sortDate === date && sort === "sales_desc" ? "从小到大" : "从大到小"}排序`} title="点击切换此日期销量升序/降序">{date.slice(5)} {sortDate === date && sort.startsWith("sales_") ? sort === "sales_desc" ? "↓" : "↑" : "↕"}<span>销售量</span></button></TableHead>)}<TableHead className="compact-turnover" title="当前库存÷近7天未四舍五入的均值；估算库存可支撑天数">库存周转<span>天 · 估算</span></TableHead></TableRow></TableHeader>
        <TableBody>{view.rows.map((row,i) => <TableRow key={row.goodsNo} onClick={() => setSelected(row)} className="compact-data-row"><TableCell className="compact-index">{(view.page - 1) * view.pageSize + i + 1}</TableCell><TableCell className="compact-goods"><button type="button" onClick={e => { e.stopPropagation(); setSelected(row); }} title={row.goodsName}><strong>{row.goodsNo}</strong><span>{row.goodsName}</span></button></TableCell><TableCell className="compact-current"><strong>{quantity(row.quantity)}</strong></TableCell><TableCell className="compact-metric"><MetricValue metrics={row.metrics} field="average7"/></TableCell><TableCell className="compact-trend"><Sparkline dates={dates} values={row.sales || {}}/></TableCell>{dates.map(date => <TableCell key={date} className={`compact-date ${hasInbound(row,date) ? "compact-inbound-day" : ""}`}><SalesValue row={row} date={date}/></TableCell>)}<TableCell className="compact-turnover"><MetricValue metrics={row.metrics} field="turnoverDays"/></TableCell></TableRow>)}
        {!view.rows.length && <TableRow><TableCell colSpan={6 + dates.length}><div className="compact-empty"><Warehouse size={32}/><strong>{loading ? "正在读取仓库数据" : view.snapshot ? "没有符合条件的货品" : "从第一次库存采集开始"}</strong><p>{view.snapshot ? "可调整搜索条件。" : "自动获取该仓库 SKU 并采集可购数量，无需设置采集范围。"}</p>{!view.snapshot && <Button onClick={sync} disabled={syncing || loading || !view.configured}>{syncing ? "采集中…" : "采集库存"}</Button>}</div></TableCell></TableRow>}
        </TableBody></Table>
      </div>
      <footer className="compact-footer"><span>共 {view.totalRows.toLocaleString()} 个货品</span><Select value={pageSize} onValueChange={v => { if(v) { setPageSize(v); setPage(1); } }}><SelectTrigger aria-label="每页条数"><SelectValue>每页 {pageSize} 条</SelectValue></SelectTrigger><SelectContent>{[100,200,500,1000].map(n => <SelectItem key={n} value={String(n)}>每页 {n} 条</SelectItem>)}</SelectContent></Select><Pagination className="compact-pagination"><Button variant="outline" size="icon" aria-label="上一页" disabled={view.page <= 1 || loading} onClick={() => setPage(view.page - 1)}><ArrowLeft/></Button><span>{view.page} / {totalPages}</span><Button variant="outline" size="icon" aria-label="下一页" disabled={view.page >= totalPages || loading} onClick={() => setPage(view.page + 1)}><ArrowRight/></Button></Pagination></footer>
    </section>
    <p className="compact-footnote"><span className="compact-inbound-legend"/> 黄色表示该采集区间有入库，点击货品查看单据。点击日期列可切换销量升序/降序。销量为库存消耗估算：所有可比较商品按“上次库存 + 区间内实际入库 − 本次库存”核算。其他库存变动仍可能影响结果。均值 = 近7天销量总和 ÷ 7；周转 = 当前库存 ÷ 均值。缺日、入库未核验或未解释的日期不参与指标计算。</p>
    <Dialog open={addOpen} onOpenChange={setAddOpen}><DialogContent className="compact-dialog"><DialogHeader><DialogTitle>增加仓库</DialogTitle><DialogDescription>填入吉客云仓库编码。首次采集后自动识别仓库名称和 SKU。</DialogDescription></DialogHeader><form onSubmit={e => { e.preventDefault(); void add(); }}><label htmlFor="new-code">仓库编码</label><Input id="new-code" placeholder="例如 CK031" value={newCode} onChange={e => setNewCode(e.target.value)} required maxLength={50}/><label htmlFor="new-name">显示名称（可选）</label><Input id="new-name" placeholder="首次采集后同步官方名称" value={newName} onChange={e => setNewName(e.target.value)} maxLength={80}/><p>默认每日北京时间 08:00 采集。服务器启用定时任务后自动执行。</p>{error && <p role="alert" className="compact-error">{error}</p>}<Button type="submit" disabled={savingWarehouse}>{savingWarehouse ? "保存中…" : "增加仓库"}</Button></form></DialogContent></Dialog>
    <Dialog open={help} onOpenChange={setHelp}><DialogContent className="compact-dialog"><DialogHeader><DialogTitle>数据口径与自动采集</DialogTitle><DialogDescription>库存来自吉客云实时接口，销售量按你指定的库存差额计算。</DialogDescription></DialogHeader><div className="compact-help"><p><strong>采集流程</strong><br/>仓库编码 → erp.stockquantity.get 游标取得 SKU → erp-stock.stock.skulist 查询可购数量。无条码或条码查询未返回时，改用货品编码查询，再按 SKU 身份核验。</p><p><strong>当前库存</strong><br/>显示最近采集的已核验 orderAbleQuantity。未取得库存的规格保留清单、不填零；含缺失规格的货品不展示部分合计、不参与销售差额。接口失败时保留上次成功数据。</p><p><strong>每日销售</strong><br/>上次基准库存 + 区间内实际入库 − 本次基准库存，记在上次基准日期。按仓库及两次采集时间分页查询 erp-busiorder.goodsdocin.search（含归档记录），再按货品编码汇总，核验时间和单位。库存下降、持平或增加都核算入库。查询失败或入库量无法解释增加时，销量显示待核验，原始差额和单据保留在详情。每天08:00后第一次成功采集为固定基准；手动刷新更新当前库存并核验本次采集区间，补查近30天未完成核验的每日区间。缺日不跨天计算。所有可比较日期均核验入库，仍属于消耗估算，不等同实际订单销量。</p><p><strong>每天 08:00（北京时间）</strong><br/>仓库已保存默认采集时间。定时状态依据服务器后台心跳显示；未运行时请检查后台进程和定时配置。无需浏览器一直打开。</p></div></DialogContent></Dialog>
    <Dialog open={unavailableOpen} onOpenChange={setUnavailableOpen}><DialogContent className="compact-dialog compact-wide-dialog"><DialogHeader><DialogTitle>{code} 未取得库存的 SKU</DialogTitle><DialogDescription>已尝试条码或货品编码查询。以下记录不填零；含缺失规格的货品不展示部分合计、不参与销售差额。Excel 的采集说明也保留此清单。</DialogDescription></DialogHeader><div className="compact-records"><Table><TableHeader><TableRow><TableHead>货品编码 / 名称</TableHead><TableHead>SKU / 条码</TableHead><TableHead>原因</TableHead></TableRow></TableHeader><TableBody>{view.unavailableSkus?.map(row => <TableRow key={row.skuId}><TableCell>{row.goodsNo}<br/>{row.goodsName}</TableCell><TableCell>{row.skuId}<br/>{row.skuBarcode || "无条码"}</TableCell><TableCell>{row.reason}</TableCell></TableRow>)}</TableBody></Table></div></DialogContent></Dialog>
    <Dialog open={recordsOpen} onOpenChange={setRecordsOpen}><DialogContent className="compact-dialog compact-wide-dialog"><DialogHeader><DialogTitle>{code} 采集记录</DialogTitle><DialogDescription>仅显示当前仓库最近 20 次采集。</DialogDescription></DialogHeader><div className="compact-records">{runs.length ? runs.map(run => <div key={run.id}><strong>{run.status === "complete" ? "已完成" : run.status === "failed" ? "失败" : run.status === "queued" ? "排队中" : "采集中"}</strong><span>{time(run.startedAt)}</span><p>{run.message || `${run.pageCount} 页 · ${run.recordCount.toLocaleString()} 条记录`}</p></div>) : <p>暂无采集记录</p>}</div></DialogContent></Dialog>
    <Dialog open={alertsOpen} onOpenChange={setAlertsOpen}><DialogContent className="compact-dialog"><DialogHeader><DialogTitle>钉钉库存预警</DialogTitle><DialogDescription>完整采集后，低于或等于阈值的货品发送至已配置群。此设置适用于所有仓库。</DialogDescription></DialogHeader><div className="compact-alert-switch"><label htmlFor="alert-enabled">启用预警</label><Switch id="alert-enabled" checked={enabled} onCheckedChange={setEnabled} disabled={!alerts.robotConfigured}/></div><label htmlFor="alert-threshold">库存阈值</label><Input id="alert-threshold" value={threshold} onChange={e => setThreshold(e.target.value)}/>{!alerts.robotConfigured && <p>机器人尚未配置完整，预警暂未启用。</p>}{alerts.lastResult && <p>{alerts.lastResult}</p>}{error && <p className="compact-error" role="alert">{error}</p>}<Button onClick={saveAlerts} disabled={saving}>{saving ? "保存中…" : "保存设置"}</Button></DialogContent></Dialog>
    <Dialog open={!!selected} onOpenChange={v => { if(!v) setSelected(null); }}><DialogContent className="compact-dialog sales-calendar-dialog"><DialogHeader><DialogTitle>{selected?.goodsNo}</DialogTitle><DialogDescription>{selected?.goodsName}</DialogDescription></DialogHeader>{selected && <SalesCalendar key={`${code}:${selected.goodsNo}`} warehouseCode={code} goodsNo={selected.goodsNo} initialMonth={(dates[0] || view.snapshot?.date || new Date().toISOString().slice(0,10)).slice(0,7)}/>}</DialogContent></Dialog>
  </main>;
}
