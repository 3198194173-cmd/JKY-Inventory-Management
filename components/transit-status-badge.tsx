'use client';
import {useEffect,useState} from 'react';
import {compareQuantity} from '@/lib/decimal';
import type {TransitMetric} from '@/lib/transit';

export function TransitStatusBadge({transit,unitName}:{transit?:TransitMetric;unitName:string}){
  const [expired,setExpired]=useState(false);
  const completedAt=transit?.completedAt;
  useEffect(()=>{
    const remaining=completedAt?Date.parse(completedAt)+86400000-Date.now():0;
    setExpired(remaining<=0);
    if(remaining>0){const timer=window.setTimeout(()=>setExpired(true),remaining);return()=>window.clearTimeout(timer);}
  },[completedAt]);
  if(transit?.quantity!=null&&compareQuantity(transit.quantity,'0')>0)return <em className="compact-awaiting-inbound" title={`尚有 ${transit.quantity} ${unitName} 等待入库，含部分入库后的剩余数量`}>等待入库</em>;
  if(transit?.quantity==='0'&&completedAt&&!expired)return <em className="compact-completed-inbound" title={`已确认入库完成，标记保留至 ${new Date(Date.parse(completedAt)+86400000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}`}>入库完成</em>;
  return null;
}
