import { salesTrend, type TrendSample } from '@/lib/sales-trend';
const scaleLabel=(n:number)=>Math.abs(n)>=10000?`${Number((n/10000).toPrecision(3))}万`:Number(n.toPrecision(3)).toString();
export function SalesTrend({samples,compact=false}:{samples:TrendSample[];compact?:boolean}) {
  const width=compact?140:400,height=compact?44:160,chart=salesTrend(samples,width,height,compact);
  if(!chart)return <span className="compact-muted">暂无销量数据</span>;
  const valid=chart.points.filter(p=>p.y!=null && Number.isFinite(p.y));
  return <svg className={`sales-trend-chart ${compact?'sales-trend-compact':''}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="净销量趋势，横轴为日期，纵轴为销量，包含零刻度；缺失日期断线">
    <title>{valid.map(p=>`${p.date}: ${p.value}${p.provisional?'（临时）':''}`).join('；')}</title>
    {chart.ticks.map(n=><g key={n}><line x1={chart.left} x2={chart.right} y1={chart.y(n)} y2={chart.y(n)} stroke={n===0?'#a5b3cb':'#e5eaf3'} strokeDasharray={n===0?undefined:'2 3'}/><text x={chart.left-4} y={chart.y(n)+3} textAnchor="end" fill="#7c8ca4" fontSize={compact?8:10}>{scaleLabel(n)}</text></g>)}
    <line x1={chart.left} x2={chart.left} y1={chart.top} y2={chart.bottom} stroke="#a5b3cb"/>
    {chart.segments.map((s,i)=><line key={i} {...{x1:s.x1,y1:s.y1,x2:s.x2,y2:s.y2}} stroke="#4371eb" strokeWidth={compact?1.5:2} strokeDasharray={s.provisional?'3 3':undefined}/>)}
    {valid.map(p=><circle key={p.date} cx={p.x} cy={p.y!} r={compact?2:3} fill={p.provisional?'#fff':'#4371eb'} stroke="#4371eb" tabIndex={compact?undefined:0}><title>{p.date} · 净销量 {p.value}{p.provisional?'（临时，待次日采集定稿）':''}</title></circle>)}
    {chart.points.filter((_,i,all)=>i===0 || i===all.length-1 || (!compact && i%7===0)).map(p=><text key={p.date} x={p.x} y={height-2} textAnchor={p===chart.points[0]?'start':p===chart.points.at(-1)?'end':'middle'} fill="#7c8ca4" fontSize={compact?8:10}>{p.date.slice(5)}</text>)}
  </svg>;
}
