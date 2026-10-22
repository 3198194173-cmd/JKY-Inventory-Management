'use client';
import { Settings2 } from 'lucide-react';
import type { KingdeeRules } from '@/lib/kingdee-types';

export function KingdeeWarehouseScope({rules,onManage}:{rules:KingdeeRules;onManage?:()=>void}){
  return <section className="kd-warehouse-scope" aria-label="公司库存内外仓名单"><header><div><strong>内外仓统计名单</strong><small>规则 v{rules.version} · 采集后按此名单归组</small></div>{onManage&&<button type="button" onClick={onManage}><Settings2 size={14}/>管理分组</button>}</header>
    <div className="kd-scope-groups">{(['inner','outer','excluded'] as const).map(group=>{
      const members=rules.warehouses.members.filter(member=>member.group===group);if(!members.length)return null;
      return <div key={group}><h4>{group==='inner'?'内仓':group==='outer'?'外仓':'明确排除'}<span>{members.length}</span></h4><ul>{members.map(member=><li key={member.name}>{member.name}</li>)}</ul></div>;
    })}</div><p>名单外仓库保留在采集原件中，不计入公司结存。此名单不改变星空保存方案的查询范围。</p>
  </section>;
}
