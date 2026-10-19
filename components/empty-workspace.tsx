"use client";
import { Warehouse } from 'lucide-react';
import { AccountBar, type AccountProfile } from './account-bar';
import { WarehousePicker } from './warehouse-picker';
import { useRouter } from 'next/navigation';
export function EmptyWorkspace({profile}:{profile:AccountProfile}){
  const router = useRouter();
  return <main className="account-page"><AccountBar profile={profile}/><section className="empty-workspace"><Warehouse size={32}/><h1>选择你的第一个仓库</h1><p>登录后自动读取仓库列表。你的仓库配置、采集记录和预警设置独立保存。</p><WarehousePicker onAdded={() => router.refresh()}/><a href="/login">返回登录页</a></section></main>;
}
