"use client";
import { useEffect, useId, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import type { AvailableWarehouse } from '@/lib/jackyun-warehouses';
import type { WarehouseInfo } from '@/lib/inventory-types';

async function result<T>(response: Response): Promise<T> {
  let data: T & { error?: string };
  try { data = await response.json(); } catch { throw new Error('服务暂时无法读取，请重试'); }
  if (!response.ok) throw new Error(data.error || '操作失败，请重试');
  return data;
}

export function WarehousePicker({ existingCodes = [], onAdded }: { existingCodes?: string[]; onAdded: (warehouses: WarehouseInfo[], code: string, queued: boolean) => void }) {
  const id = useId();
  const [warehouses, setWarehouses] = useState<AvailableWarehouse[]>([]);
  const [query, setQuery] = useState(''), [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const [manual, setManual] = useState(false), [manualCode, setManualCode] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/warehouses/available' + (revision ? '?refresh=1' : ''), { signal: controller.signal, cache: 'no-store' })
      .then(response => result<{ warehouses: AvailableWarehouse[] }>(response))
      .then(data => { if (!controller.signal.aborted) setWarehouses(data.warehouses); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  const available = warehouses.filter(w => !existingCodes.includes(w.code));
  const filtered = available.filter(w => (w.name + ' ' + w.code).toLowerCase().includes(query.trim().toLowerCase()));
  async function add(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const code = manual ? manualCode.trim() : selected;
      if (manual) {
        const list = await result<WarehouseInfo[]>(await fetch('/api/warehouses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }));
        onAdded(list, code, false);
      } else {
        const data = await result<{ warehouses: WarehouseInfo[]; queued: boolean }>(await fetch('/api/warehouses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, source: 'jackyun', initialize: true }) }));
        onAdded(data.warehouses, code, data.queued);
      }
    } catch (e) { setError(e instanceof Error ? e.message : '添加仓库失败'); }
    finally { setBusy(false); }
  }
  return <form className="warehouse-picker" onSubmit={add}>
    {!manual && <>
      <div className="warehouse-picker-tools"><label htmlFor={id + '-query'}>搜索仓库名称或编码</label><Button type="button" variant="ghost" size="sm" disabled={loading || busy} onClick={() => { setError(''); setWarehouses([]); setLoading(true); setSelected(''); setRevision(v => v + 1); }}>重新获取</Button></div>
      <Input id={id + '-query'} value={query} onChange={e => { setQuery(e.target.value); setSelected(''); }} placeholder="例如：泰国、成品仓、CK031" disabled={busy}/>
      {loading ? <p role="status">正在从吉客云获取仓库列表…</p> : <>
        <label htmlFor={id + '-warehouse'}>选择仓库（{filtered.length} 个可选）</label>
        <select id={id + '-warehouse'} value={selected} onChange={e => setSelected(e.target.value)} required disabled={busy || !filtered.length}>
          <option value="">请选择要采集的仓库</option>
          {selected && !filtered.some(w => w.code === selected) && available.filter(w => w.code === selected).map(w => <option key={w.code} value={w.code}>{w.name} · {w.code}</option>)}
          {filtered.map(w => <option key={w.code} value={w.code}>{w.name} · {w.code}</option>)}
        </select>
        {!filtered.length && !error && <p>{warehouses.length ? '没有符合条件的可添加仓库；已添加的仓库不会重复显示。' : '当前应用没有返回可用仓库，请管理员核对吉客云授权范围。'}</p>}
      </>}
      <p className="warehouse-picker-hint">显示当前应用已授权的可用仓库。添加后自动开始库存初始化，可在采集记录中查看进度。</p>
    </>}
    {manual && <><label htmlFor={id + '-code'}>仓库编码</label><Input id={id + '-code'} required maxLength={50} value={manualCode} onChange={e => setManualCode(e.target.value)} placeholder="例如 CK031" disabled={busy}/><p className="warehouse-picker-hint">手动添加后，请在库存页点击“采集库存”。</p></>}
    {error && <p role="alert" className="compact-error">{error}</p>}
    <Button type="submit" disabled={busy || (!manual && (loading || !selected))}>{busy ? '正在添加…' : manual ? '手动添加仓库' : '添加并初始化采集'}</Button>
    <button type="button" className="warehouse-picker-fallback" disabled={busy} onClick={() => { setManual(v => !v); setError(''); }}>{manual ? '返回自动获取列表' : '已知编码？手动添加'}</button>
  </form>;
}
