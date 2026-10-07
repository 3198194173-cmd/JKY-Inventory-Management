"use client";
import { useEffect, useMemo, useRef, useState } from 'react';
import { salesTrendOption, type TrendSample } from '@/lib/sales-trend';
import type { EChartsType } from 'echarts/core';

let runtimePromise:Promise<typeof import('@/lib/echarts-runtime')>|undefined;
const loadRuntime=()=>runtimePromise ??= import('@/lib/echarts-runtime').catch(error=>{runtimePromise=undefined;throw error;});
export function SalesTrend({samples,compact=false}:{samples:TrendSample[];compact?:boolean}) {
  const container=useRef<HTMLDivElement>(null),chart=useRef<EChartsType|null>(null);
  const option=useMemo(()=>salesTrendOption(samples,compact),[samples,compact]);
  const latestOption=useRef(option),[failed,setFailed]=useState(false);
  const hasData=samples.some(p=>p.value!=null && Number.isFinite(Number(p.value)));
  useEffect(()=>{latestOption.current=option;chart.current?.setOption(option,{notMerge:true});},[option]);
  useEffect(()=>{
    const element=container.current;
    if(!hasData || !element)return;
    let active=true,frame=0,runtime:Awaited<ReturnType<typeof loadRuntime>>|undefined;
    const draw=()=>{
      frame=0;
      if(!active || !runtime || !element.clientWidth || !element.clientHeight)return;
      if(!chart.current) {
        chart.current=runtime.init(element,undefined,{renderer:'svg'});
        chart.current.setOption(latestOption.current,{notMerge:true});
      }else chart.current.resize();
    };
    const schedule=()=>{if(active && !frame)frame=requestAnimationFrame(draw);};
    // A collapsed monthly plot is initialized only after it becomes visible.
    const observer=new ResizeObserver(schedule);observer.observe(element);
    loadRuntime().then(module=>{if(active){runtime=module;schedule();}}).catch(()=>{if(active)setFailed(true);});
    return ()=>{active=false;observer.disconnect();cancelAnimationFrame(frame);chart.current?.dispose();chart.current=null;};
  },[hasData]);
  if(!hasData)return <span className="compact-muted">暂无销量数据</span>;
  return <div className={compact?'sales-trend-compact':'sales-trend-chart'}>
    <div ref={container} className="sales-trend-canvas" role="img" aria-label={'净销量平滑折线图，横轴为日期，纵轴为销量；'+samples.filter(p=>p.value!=null).map(p=>p.date+'：'+p.value+(p.provisional?'（临时）':'')).join('；')}/>
    {failed && <span className="sales-trend-error">图表加载失败，请刷新页面</span>}
  </div>;
}
