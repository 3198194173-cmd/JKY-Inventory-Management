"use client";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";
import { compareQuantity } from "@/lib/decimal";
import type { SalesCalendarDay, SalesCalendarMonth } from "@/lib/inventory-types";

const quantity = (value: string) => { const [a,b]=value.split("."); return a.replace(/\B(?=(\d{3})+(?!\d))/g,",")+(b ? "."+b : ""); };
const time = (value: string) => new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false});
const shiftMonth = (month: string, delta: number) => { const d=new Date(month+"-01T00:00:00Z"); d.setUTCMonth(d.getUTCMonth()+delta); return d.toISOString().slice(0,7); };
function hasInbound(day: SalesCalendarDay) {
  return !!day.correction && (day.correction.records.some(r=>compareQuantity(r.quantity,"0")>0) || (day.correction.inboundQuantity != null && compareQuantity(day.correction.inboundQuantity,"0")>0));
}
function DayAnalysis({ day }: { day: SalesCalendarDay }) {
  const correction=day.correction, verified=day.sales != null, inbound=correction?.inboundQuantity;
  const hasQuantity=inbound != null && compareQuantity(inbound,"0")!==0;
  return <section className={`sales-analysis ${hasInbound(day) ? "sales-analysis-inbound" : ""}`} aria-label={`${day.date}销量分析`}>
    <header><h3>{day.date} · 销量分析</h3><strong>{verified ? quantity(day.sales!) : day.openingQuantity == null || day.closingQuantity == null ? "暂无数据" : "待核验"}</strong></header>
    {day.openingQuantity != null && day.closingQuantity != null && <div className="sales-equation" aria-label="销量计算公式">
      <p className="sales-equation-labels">期初库存{hasQuantity ? " + 区间入库" : ""} − 期末库存 = 销售数</p>
      <p className="sales-equation-values"><span>{quantity(day.openingQuantity)}</span>{hasQuantity && <><b>+</b><span className="sales-equation-inbound">{quantity(inbound!)}</span></>}<b>−</b><span>{quantity(day.closingQuantity)}</span><b>=</b><strong>{verified ? quantity(day.sales!) : "—"}</strong></p>
    </div>}
    {day.windowStart && day.windowEnd && <p className="sales-analysis-time">北京时间 {time(day.windowStart)} → {time(day.windowEnd)}</p>}
    {!verified && <p className="sales-analysis-message">{day.openingQuantity == null || day.closingQuantity == null ? "缺少相邻日期的完整库存基准，暂不能计算。" : correction?.error || "入库或库存口径尚未核验，暂不能确定销售数。"}</p>}
    {!!correction?.records.length && <details className="sales-inbound-details"><summary>入库单据（{correction.records.length} 条）</summary><ul>{correction.records.map(r=><li key={r.recId}><div><strong>{r.typeName} · {quantity(r.quantity)}</strong><time>{time(r.inOutDate)}</time></div><span>单号：{r.documentNo}</span></li>)}</ul></details>}
  </section>;
}
export function SalesCalendar({ warehouseCode, goodsNo, initialMonth }: { warehouseCode:string;goodsNo:string;initialMonth:string }) {
  const [month,setMonth]=useState(initialMonth), [data,setData]=useState<SalesCalendarMonth|null>(null);
  const [selected,setSelected]=useState<string|null>(null), [error,setError]=useState("");
  const [loading,setLoading]=useState(true),[retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    fetch(`/api/sales-calendar?${new URLSearchParams({warehouseCode,goodsNo,month})}`,{signal:controller.signal})
      .then(async response=>{
        const raw=await response.text();let result:SalesCalendarMonth & {error?:string};
        try { result=JSON.parse(raw); } catch { throw new Error("暂时无法读取销量数据，请重试。"); }
        if (!response.ok) throw new Error(result.error || "销量数据读取失败");
        return result;
      }).then(result=>{setData(result);setError("");})
      .catch(e=>{if(e.name!=="AbortError")setError(e.message);})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[warehouseCode,goodsNo,month,retry]);
  function changeMonth(value:string) {
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value===month || (data && (value<data.firstMonth || value>data.lastMonth)))return;
    setLoading(true);setError("");setSelected(null);setMonth(value);
  }
  const current=data?.month===month && !loading && !error ? data : null;
  const day=current?.days.find(d=>d.date===selected);
  const offset=(new Date(month+"-01T00:00:00Z").getUTCDay()+6)%7;
  const months:string[]=[];
  for(let value=data?.firstMonth || month;value<=(data?.lastMonth && data.lastMonth>month ? data.lastMonth : month);value=shiftMonth(value,1)) months.push(value);
  return <div className="sales-calendar-content">
    <div className="sales-calendar-layout"><div className="sales-calendar-month">
    <div className="sales-calendar-toolbar">
      <button type="button" aria-label="上个月" disabled={loading || !data || month<=data.firstMonth} onClick={()=>changeMonth(shiftMonth(month,-1))}><ChevronLeft size={18}/></button>
      <label><span className="sr-only">销售月份</span><select value={month} onChange={e=>changeMonth(e.target.value)}>{months.map(value=><option value={value} key={value}>{value.slice(0,4)}年{Number(value.slice(5))}月</option>)}</select></label>
      <button type="button" aria-label="下个月" disabled={loading || !data || month>=data.lastMonth} onClick={()=>changeMonth(shiftMonth(month,1))}><ChevronRight size={18}/></button>
    </div>
    <div className="sales-calendar-weekdays" aria-hidden="true">{["一","二","三","四","五","六","日"].map(d=><span key={d}>{d}</span>)}</div>
    <div className="sales-calendar-grid" aria-label={`${month}每日销量`} aria-busy={loading}>
      {loading ? <p className="sales-calendar-state" role="status"><LoaderCircle size={18} className="animate-spin"/>正在读取本月销量…</p> : error ? <div className="sales-calendar-state" role="alert"><p>{error}</p><button type="button" onClick={()=>{setLoading(true);setRetry(n=>n+1);}}>重试</button></div> : current && <>
        {Array.from({length:offset},(_,i)=><span key={`blank-${i}`} aria-hidden="true"/>)}
        {current.days.map(d=><button type="button" key={d.date} className={`sales-calendar-day ${hasInbound(d) ? "sales-calendar-inbound" : ""} ${d.sales == null ? "sales-calendar-missing" : ""}`} aria-label={`${d.date}，销量${d.sales == null ? "暂无有效数据" : d.sales}${hasInbound(d) ? "，有入库" : ""}`} aria-pressed={selected===d.date} onClick={()=>setSelected(selected===d.date ? null : d.date)}><span>{Number(d.date.slice(-2))}</span><strong>{d.sales == null ? "—" : quantity(d.sales)}</strong></button>)}
      </>}
    </div>
    <p className="sales-calendar-hint"><span className="compact-inbound-legend"/> 有入库　— 暂无有效数据　点击日期查看计算</p>
    </div><div className="sales-calendar-analysis-pane">{day ? <DayAnalysis key={day.date} day={day}/> : <div className="sales-calendar-select-hint"><strong>选择一个日期</strong><p>查看当天的库存与入库核算</p></div>}</div></div>
    <p className="sales-calendar-caption">日期沿用主表的采集区间起始日，通常为当日08:00至次日08:00；销售数为库存消耗估算。</p>
  </div>;
}
