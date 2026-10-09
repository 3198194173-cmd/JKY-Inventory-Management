"use client";
import { useState } from "react";
import { Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription } from "@/components/ui/dialog";

export function CollectionSettingsDialog({open,onOpenChange,warehouseCode,warehouseName,dailyTime,scheduleActive,onSaved}:{
  open:boolean;onOpenChange:(open:boolean)=>void;warehouseCode:string;warehouseName:string;dailyTime:string;scheduleActive:boolean;onSaved:(data:{code:string;dailyTime:string})=>void;
}) {
  const [time,setTime]=useState(dailyTime),[saving,setSaving]=useState(false),[error,setError]=useState("");
  async function save(){
    if(saving)return;setSaving(true);setError("");
    try{
      const response=await fetch("/api/warehouses/schedule",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({warehouseCode,dailyTime:time})});
      const data=await response.json() as {code:string;dailyTime:string;error?:string};if(!response.ok)throw new Error(data.error||"保存失败");onSaved(data);onOpenChange(false);
    }catch(e){setError(e instanceof Error?e.message:"保存失败");}finally{setSaving(false);}
  }
  return <Dialog open={open} onOpenChange={value=>{if(!saving)onOpenChange(value);}}><DialogContent className="collection-settings-dialog">
    <DialogHeader><DialogTitle><Clock3 size={19}/>采集设置</DialogTitle><DialogDescription>{warehouseName}（{warehouseCode}）· 仅设置当前仓库</DialogDescription></DialogHeader>
    <form onSubmit={e=>{e.preventDefault();void save();}}><label htmlFor="collection-daily-time">每日自动采集时间 · 北京时间</label><Input id="collection-daily-time" type="time" required value={time} onChange={e=>setTime(e.target.value)} disabled={saving}/>
      <p>预警规则、接收群和发送时间在“预警”中单独设置。修改采集时间不会重写已保存的每日基准。</p>
      {!scheduleActive&&<p className="alert-warning">云端定时尚未运行，请启用服务器 worker 定时任务。</p>}{error&&<p className="alert-warning" role="alert">{error}</p>}
      <div><Button type="submit" disabled={saving}>{saving?"保存中…":"保存采集时间"}</Button></div>
    </form>
  </DialogContent></Dialog>;
}
