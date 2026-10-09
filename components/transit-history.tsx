'use client';
import {useEffect,useState} from 'react';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import type {TransitHistoryView} from '@/lib/transit-store';

const stateName=(state:string)=>({'1':'入库等待','2':'部分入库','3':'入库完成'}[state]||'状态待核验');
export function TransitHistory({code,goodsNo,open,onOpenChange}:{code:string;goodsNo:string;open:boolean;onOpenChange:(v:boolean)=>void}){
  const [date,setDate]=useState(''),[data,setData]=useState<TransitHistoryView|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[search,setSearch]=useState('');
  useEffect(()=>{if(!open)return;const controller=new AbortController();
    fetch(`/api/transit?${new URLSearchParams({warehouseCode:code,goodsNo,date})}`,{signal:controller.signal}).then(async r=>{const json=await r.json() as TransitHistoryView & {error?:string};if(!r.ok)throw new Error(json.error||'读取在途失败');return json;}).then(d=>{if(!controller.signal.aborted){setData(d);setError('');}}).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[code,goodsNo,open,date]);
  const visible=data?.goods.filter(g=>(g.goodsNo+' '+g.goodsName).toLowerCase().includes(search.toLowerCase()))||[];
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="compact-dialog compact-wide-dialog transit-dialog"><DialogHeader><DialogTitle>{goodsNo||code} · 在途记录</DialogTitle><DialogDescription>按采集日期查看剩余在途和申请单。未取得库存的在途商品也会列出。</DialogDescription></DialogHeader>
    <div className="transit-controls"><label>采集日期 <input type="date" aria-label="在途采集日期" value={date||data?.selected||''} max={data?.dates[0]} min={data?.dates.at(-1)} onChange={e=>{setDate(e.target.value);setLoading(true);}}/></label><input aria-label="搜索在途商品" placeholder="搜索编码 / 名称" value={search} onChange={e=>setSearch(e.target.value)}/></div>
    {error?<p role="alert">{error}</p>:loading?<p role="status">正在读取记录…</p>:<div className="transit-content">
      <p className="transit-note">{data?.status==='complete'?'本次在途已核验':data?.error||'所选日期没有在途采集记录；更新后采集一次即可开始记录。'}{data?.from&&` · 申请查询起点 ${data.from.slice(0,10)}`}</p>
      {!goodsNo&&visible.length>0&&<table className="transit-table"><thead><tr><th>商品编码 / 名称</th><th>当前库存</th><th>剩余在途</th></tr></thead><tbody>{visible.map(g=><tr key={g.goodsNo}><td>{g.goodsNo}<small>{g.goodsName}</small></td><td>{g.stock??'未取得'}</td><td>{g.quantity??'待核验'}</td></tr>)}</tbody></table>}
      {data?.documents.filter(d=>!search||d.no.includes(search)||d.lines.some(l=>(l.goodsNo+' '+l.goodsName).toLowerCase().includes(search.toLowerCase()))).map(d=><details key={d.id} className="transit-document" open={!!goodsNo}><summary><strong>{d.no}</strong> · {d.audit==='3'?'已关闭':stateName(d.state)} {d.error&&'· 待核验'}</summary><p className="transit-note">关联来源：{d.source||'—'}{d.receiptStatus&&` · ${d.receiptStatus}`}</p>{d.error&&<p role="alert">{d.error}</p>}<table className="transit-table"><thead><tr><th>商品</th><th>申请</th><th>已入库</th><th>剩余</th></tr></thead><tbody>{d.lines.map(l=><tr key={l.id}><td>{l.goodsNo}<small>{l.goodsName}</small></td><td>{l.applied}</td><td>{l.received}</td><td>{l.remaining}</td></tr>)}</tbody></table>{d.receipts?.map((r,i)=><p className="transit-note" key={r.no+'-'+i}>实际入库 {r.no} · {r.goodsNo} · {r.quantity} {r.unitName}</p>)}</details>)}
      {data?.status==='complete'&&!data.documents.length&&<p>本次完整查询没有等待入库申请单，在途为 0。</p>}
    </div>}
  </DialogContent></Dialog>;
}
