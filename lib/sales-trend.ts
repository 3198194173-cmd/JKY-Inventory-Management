import type { EChartsOption } from 'echarts';
export type TrendSample = {date:string;value:string|null;provisional?:boolean};

// Category axes retain one slot per calendar day; omitted dates are explicit
// gaps rather than being compressed or filled with zero sales.
export function trendSamples(samples:TrendSample[]):TrendSample[] {
  const sorted=samples.filter(s=>/^\d{4}-\d{2}-\d{2}$/.test(s.date)).sort((a,b)=>a.date.localeCompare(b.date));
  if(!sorted.length)return [];
  const byDate=new Map(sorted.map(s=>[s.date,s])),start=Date.parse(sorted[0].date+'T00:00:00Z'),end=Date.parse(sorted.at(-1)!.date+'T00:00:00Z');
  if(!Number.isFinite(start) || !Number.isFinite(end) || end-start>366*86400000)return [];
  return Array.from({length:Math.round((end-start)/86400000)+1},(_,i)=>{
    const date=new Date(start+i*86400000).toISOString().slice(0,10),sample=byDate.get(date);
    return sample || {date,value:null};
  });
}
const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function salesTrendOption(samples:TrendSample[],compact=false):EChartsOption {
  const points=trendSamples(samples);
  return {
    animation:false,
    color:['#5470c6'],
    grid:{left:compact?3:42,right:compact?3:16,top:compact?6:18,bottom:compact?5:28},
    tooltip:{trigger:'axis',renderMode:'html',appendTo:()=>document.body,
      extraCssText:'z-index:10000;pointer-events:none;',axisPointer:{type:'line'},
      formatter:params=>{
        const item=Array.isArray(params)?params[0]:params,sample=points[item?.dataIndex ?? -1];
        return sample ? escapeHtml(sample.date)+'<br/>净销量：'+escapeHtml(sample.value ?? '暂无数据')+(sample.provisional?'（临时，待次日采集定稿）':'') : '';
      }},
    xAxis:{type:'category',data:points.map(p=>p.date),boundaryGap:false,
      show:!compact,axisLabel:{formatter:value=>value.slice(5),fontSize:11,color:'#7c8ca4'},
      axisLine:{lineStyle:{color:'#b7c2d2'}},axisTick:{show:false}},
    yAxis:{type:'value',show:!compact,scale:false,splitNumber:3,
      axisLabel:{fontSize:11,color:'#7c8ca4'},splitLine:{lineStyle:{color:'#e5eaf3'}}},
    series:[{name:'净销量',type:'line',smooth:true,connectNulls:false,
      symbol:'emptyCircle',symbolSize:compact?3:6,showSymbol:true,
      lineStyle:{width:compact?1.6:2},
      data:points.map(p=>{
        const value=p.value==null?null:Number(p.value),valid=value!=null && Number.isFinite(value)?value:null;
        return p.provisional && valid!=null ? {value:valid,itemStyle:{color:'#d69a25',borderColor:'#d69a25'}} : valid;
      })}]
  };
}
