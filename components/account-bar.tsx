"use client";
import { useState } from 'react';
export type AccountProfile={id:string;name:string;role:'admin'|'member';targetId:string;targetName:string};
export function AccountBar({profile}:{profile:AccountProfile}){
  const [error,setError]=useState('');
  async function exit(){try{const r=await fetch('/api/workspace',{method:'DELETE'});if(!r.ok)throw new Error('退出管理视图失败，请重试');window.location.assign('/');}catch(e){setError(e instanceof Error?e.message:'操作失败');}}
  return <div className="account-bar"><div className="account-identity"><span className="account-avatar" aria-hidden="true">{profile.name.slice(0,1)}</span><strong>{profile.name}</strong><span>{profile.role==='admin'?'管理员':'成员'}</span>{profile.role==='admin'&&<a href="/admin/accounts">账户管理</a>}</div>{profile.targetId!==profile.id&&<div className="account-workspace" role="status">正在管理：<strong>{profile.targetName}</strong><button type="button" onClick={exit}>回到我的空间</button></div>}{error&&<p role="alert">{error}</p>}</div>;
}
