export type TrendSample = {date:string;value:string|null;provisional?:boolean};
export function salesTrend(samples: TrendSample[], width:number, height:number, compact=false) {
  const left=compact?25:42,right=width-8,top=compact?4:12,bottom=height-(compact?12:24);
  const sorted=[...samples].sort((a,b)=>a.date.localeCompare(b.date));
  const points=sorted.map(s=>({...s,t:Date.parse(s.date+'T00:00:00Z'),n:s.value==null?null:Number(s.value)}));
  const values=points.flatMap(p=>p.n!=null && Number.isFinite(p.n) ? [p.n] : []);
  if(!values.length)return null;
  const min=Math.min(0,...values),max=Math.max(0,...values),span=max-min || 1;
  const power=10**Math.floor(Math.log10(span/3)),factor=span/3/power;
  const step=(factor<=1?1:factor<=2?2:factor<=5?5:10)*power;
  const low=Math.floor(min/step)*step,high=Math.ceil(max/step)*step || (low===0?step:0);
  const y=(n:number)=>bottom-(n-low)/(high-low)*(bottom-top);
  const start=points[0].t,end=points.at(-1)!.t;
  const plotted=points.map(p=>({...p,x:start===end?(left+right)/2:left+(p.t-start)/(end-start)*(right-left),y:p.n==null?null:y(p.n)}));
  const segments=plotted.slice(1).flatMap((p,i)=>{
    const previous=plotted[i];
    return previous.y!=null && p.y!=null && Number.isFinite(previous.y) && Number.isFinite(p.y) && p.t-previous.t===86400000
      ? [{x1:previous.x,y1:previous.y,x2:p.x,y2:p.y,provisional:!!(p.provisional || previous.provisional)}] : [];
  });
  const ticks=compact?[...new Set([low,high,0])]:Array.from({length:Math.round((high-low)/step)+1},(_,i)=>Number((low+i*step).toPrecision(12)));
  return {points:plotted,segments,ticks,left,right,top,bottom,zero:y(0),y};
}
