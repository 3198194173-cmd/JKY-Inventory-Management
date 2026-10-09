"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, BellRing, Check, Eye, LoaderCircle, RefreshCw, Send, Warehouse } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AlertSettings } from "@/lib/alerts-store";
import type { DingTalkGroupState } from "@/lib/dingtalk-groups-store";
import type { ManualAlertRequest, ManualAlertResult } from "@/lib/manual-alerts";
import { normalizeTurnoverThreshold, normalizeTurnoverDays } from "@/lib/turnover-alert";
import type { TurnoverCard } from "@/lib/dingtalk-card-data";
import { InventoryAlertCardPreview } from "@/components/inventory-alert-card-preview";

type Preview = { snapshotId: string; capturedAt: string; averageThreshold: string; turnoverDays:string; excludedNameKeywords:string[]; eligibleCount:number; excludedCount:number; count: number; incomplete: boolean; message: string; cards: TurnoverCard[]; cardConfigured: boolean };
const time = (iso: string) => new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
async function json<T>(response: Response): Promise<T> {
  let data: T & { error?: string };
  try { data = await response.json(); } catch { throw new Error("未取得服务器结果，请稍后查询发送结果"); }
  if (!response.ok) throw new Error(data.error || "操作失败，请重试");
  return data;
}

export function AlertSettingsDialog({ open, onOpenChange, initial, warehouseCode, warehouseName, onSaved, onRulePreview }: {
  open: boolean; onOpenChange: (open: boolean) => void; initial: AlertSettings;
  warehouseCode: string; warehouseName: string; onSaved: (settings: AlertSettings) => void; onRulePreview:(rule:{average:string;days:string}|null)=>void;
}) {
  const [saved, setSaved] = useState(initial), [groups, setGroups] = useState(initial.groupState);
  const [average, setAverage] = useState(initial.turnoverAverageThreshold), [enabled, setEnabled] = useState(initial.enabled);
  const [notifyTime, setNotifyTime] = useState(initial.notifyTime), [turnoverDays,setTurnoverDays]=useState(initial.turnoverDays);
  const [excludedNames,setExcludedNames]=useState(initial.excludedNameKeywords.join("\n")),[exporting,setExporting]=useState(false);
  const [selected, setSelected] = useState(initial.groupState.groups.filter(g => g.enabled).map(g => g.id));
  const [loading, setLoading] = useState(false), [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false), [sending, setSending] = useState(false), [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null), [result, setResult] = useState<ManualAlertResult | null>(null);
  const [cardPart, setCardPart] = useState(1);
  const [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const [pendingRequest, setPendingRequest] = useState<ManualAlertRequest | null>(null);
  const pending = useRef<ManualAlertRequest | null>(null), alive = useRef(true), busyRef = useRef(false);
  const busy = saved.warehouseCode !== warehouseCode || loading || refreshing || saving || sending || exporting || !!groups.syncing;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      setLoading(true); setError(""); setFeedback(""); setPreview(null);
      return fetch(`/api/alerts?${new URLSearchParams({warehouseCode})}`, { signal: controller.signal }).then(r => json<AlertSettings>(r)).then(data => {
      if (controller.signal.aborted) return;
      setSaved(data); setGroups(data.groupState); setAverage(data.turnoverAverageThreshold); setEnabled(data.enabled); setNotifyTime(data.notifyTime); setTurnoverDays(data.turnoverDays); setExcludedNames(data.excludedNameKeywords.join("\n"));onSaved(data);
      setSelected(data.groupState.groups.filter(g => g.enabled).map(g => g.id));
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    });
    return () => controller.abort();
  // Opening the dialog reads cached groups; only the refresh button contacts DingTalk.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, warehouseCode]);
  useEffect(() => {
    if (!open || !groups.syncing) return;
    const controller = new AbortController();
    const timer = setTimeout(()=>{
      // Poll only the local status of a refresh already requested by a user.
      fetch(`/api/alerts?${new URLSearchParams({warehouseCode})}`,{signal:controller.signal}).then(r=>json<AlertSettings>(r)).then(data=>{
        if(controller.signal.aborted)return;
        setGroups(data.groupState);setSelected(ids=>ids.filter(id=>data.groupState.groups.some(g=>g.id===id)));
      }).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    },2000);
    return ()=>{clearTimeout(timer);controller.abort();};
  },[open,groups,warehouseCode]);
  useEffect(()=>{
    if(!open || loading){onRulePreview(null);return;}
    try{onRulePreview({average:normalizeTurnoverThreshold(average),days:normalizeTurnoverDays(turnoverDays)});}catch{onRulePreview(null);}
  },[open,loading,average,turnoverDays,onRulePreview]);

  function keepPending(request: ManualAlertRequest | null) { pending.current = request; setPendingRequest(request); }
  const editable = !busy && !pendingRequest;
  function changed() { setPreview(null); setResult(null); setFeedback(""); setError(""); }
  async function save() {
    const data = await json<AlertSettings>(await fetch("/api/alerts", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, threshold: saved.threshold, turnoverAverageThreshold: average, selectedGroupIds: selected, notifyTime, warehouseCode, turnoverDays, excludedNameKeywords:excludedNames }) }));
    if (alive.current) { setSaved(data); setGroups(data.groupState); setAverage(data.turnoverAverageThreshold); setTurnoverDays(data.turnoverDays); setExcludedNames(data.excludedNameKeywords.join("\n")); onSaved(data); }
    return data;
  }
  async function saveOnly() {
    if (busyRef.current || busy || pending.current) return;
    busyRef.current = true; setSaving(true); setError("");
    try { await save(); setFeedback(`已保存 ${warehouseCode} 的预警设置。`); }
    catch (e) { setError(e instanceof Error ? e.message : "保存失败"); }
    finally { busyRef.current = false; if (alive.current) setSaving(false); }
  }
  async function refreshGroups() {
    if (busyRef.current || busy || pending.current) return;
    setRefreshing(true); setError("");
    try {
      const data = await json<DingTalkGroupState>(await fetch(`/api/alerts/groups?${new URLSearchParams({warehouseCode})}`, { method: "POST" }));
      setGroups(data); setSelected(ids => ids.filter(id => data.groups.some(g => g.id === id)));
    } catch (e) { setError(e instanceof Error ? e.message : "群同步失败"); }
    finally { setRefreshing(false); }
  }
  async function loadPreview() {
    const data = await json<Preview>(await fetch(`/api/alerts/preview?${new URLSearchParams({ warehouseCode, averageThreshold: average,turnoverDays,excludedNameKeywords:excludedNames })}`));
    if (alive.current) { setPreview(data); setCardPart(1); }
    return data;
  }
  async function previewOnly() {
    if (busyRef.current || busy || previewing) return;
    setPreviewing(true); setError("");
    try { await loadPreview(); } catch (e) { setError(e instanceof Error ? e.message : "预览失败"); }
    finally { setPreviewing(false); }
  }
  async function send() {
    if (busyRef.current || busy || previewing) return;
    busyRef.current = true; setSending(true); setError(""); setFeedback("");
    try {
      if (!pending.current) {
        const data = await loadPreview();
        if (data.incomplete) throw new Error("本次库存采集不完整，暂不能发送预警。");
        if (!data.count) throw new Error(data.message);
        const settings = await save();
        keepPending({ requestId: crypto.randomUUID(), warehouseCode, snapshotId: data.snapshotId,
          averageThreshold: data.averageThreshold, turnoverDays:data.turnoverDays,excludedNameKeywords:data.excludedNameKeywords, groupIds: settings.groupState.groups.filter(g => g.enabled).map(g => g.id) });
      }
      const response = await fetch("/api/alerts/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pending.current) });
      const data = await json<ManualAlertResult>(response).catch(e => {
        // These responses are known to precede a claim, so a new request is safe.
        if ([400, 409, 429].includes(response.status)) keepPending(null);
        throw e;
      });
      setResult(data);
      if (data.state === "complete") keepPending(null);
    } catch (e) { setError(e instanceof Error ? e.message : "未取得发送结果，请查询后再操作"); }
    finally { busyRef.current = false; if (alive.current) setSending(false); }
  }
  async function downloadReport(){
    if(busyRef.current || busy)return;
    busyRef.current=true;setExporting(true);setError("");
    try{
      await save();
      const response=await fetch(`/api/alerts/export?${new URLSearchParams({warehouseCode})}`);
      if(!response.ok)await json(response);
      const url=URL.createObjectURL(await response.blob()),link=document.createElement("a");link.href=url;link.download=`${warehouseCode}_预警.xlsx`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){setError(e instanceof Error?e.message:"导出失败");}finally{busyRef.current=false;setExporting(false);}
  }
  const selectedNames = groups.groups.filter(g => selected.includes(g.id)).map(g => g.name || "未命名群");
  return <Dialog open={open} onOpenChange={value => { if (!busyRef.current) onOpenChange(value); }}>
    <DialogContent className="alert-settings-dialog" onEscapeKeyDown={e => { if (busyRef.current) e.preventDefault(); }} onInteractOutside={e => { if (busyRef.current) e.preventDefault(); }}>
      <DialogHeader><DialogTitle className="alert-title"><BellRing size={20}/>库存预警</DialogTitle><DialogDescription>{warehouseName}（{warehouseCode}）· 仅设置当前仓库</DialogDescription></DialogHeader>
      <form onSubmit={e => { e.preventDefault(); void saveOnly(); }}>
        <div className="alert-body" aria-busy={loading}>
          <div className="alert-settings-grid">
            <section className="alert-card" aria-labelledby="alert-rule-heading">
              <h3 id="alert-rule-heading">预警规则</h3>
              <label className="alert-field-label" htmlFor="turnover-average-threshold">销售均值大于</label>
              <div className="alert-threshold"><Input id="turnover-average-threshold" inputMode="decimal" value={average} onChange={e => { setAverage(e.target.value); changed(); }} disabled={!editable} required maxLength={30}/><span>件 / 天</span></div>
              <label className="alert-field-label" htmlFor="turnover-days-threshold">库存周转小于</label><div className="alert-threshold"><Input id="turnover-days-threshold" inputMode="decimal" value={turnoverDays} onChange={e=>{setTurnoverDays(e.target.value);changed();}} disabled={!editable} required maxLength={30}/><span>天</span></div>
              <p>同时满足这两个条件，库存周转标红并纳入通知。</p>
              <div className="alert-auto-switch"><div><label htmlFor="alert-enabled">每日自动预警</label><small>当前仓库、每群每天一份报告</small></div><Switch id="alert-enabled" checked={enabled} onCheckedChange={v => { setEnabled(v); changed(); }} disabled={!editable || (!saved.robotConfigured && !enabled)}/></div>
            </section>
            <section className="alert-card" aria-labelledby="alert-groups-heading">
              <div className="alert-section-heading"><h3 id="alert-groups-heading">接收群 <span>{selected.length} / {groups.groups.length}</span></h3><Button type="button" variant="ghost" size="sm" onClick={() => void refreshGroups()} disabled={!saved.robotConfigured || !editable}><RefreshCw size={14} className={refreshing || groups.syncing ? "animate-spin" : undefined}/>{refreshing || groups.syncing ? "同步中" : "刷新"}</Button></div>
              <div className="alert-group-list">{groups.groups.map(group => <label className="alert-group" data-selected={selected.includes(group.id)} key={group.id}>
                <input type="checkbox" checked={selected.includes(group.id)} disabled={!editable} onChange={e => { setSelected(ids => e.target.checked ? [...ids, group.id] : ids.filter(id => id !== group.id)); changed(); }}/>
                <span><strong>{group.name || "群名称暂未获取"}</strong><small title={group.id}>{group.id}</small></span>{selected.includes(group.id) && <Check size={16}/>}
              </label>)}{!groups.groups.length && <p className="alert-group-empty">{loading ? "正在读取群列表…" : "机器人发布并加入群后，刷新列表并勾选接收群。"}</p>}</div>
              <p className="alert-sync-time">{groups.lastSyncedAt ? `上次同步：${time(groups.lastSyncedAt)}` : "点击刷新获取机器人所在群"}</p>
              {groups.error && <p className="alert-warning" role="alert">{groups.error}</p>}
              {!saved.robotConfigured && <p className="alert-warning">请先在云端配置 ClientID、ClientSecret 和 RobotCode。</p>}
            </section>
          </div>
          <section className="alert-card alert-schedule"><h3>预警发送 <span>北京时间 · {warehouseCode}</span></h3><div>
            <label htmlFor="alert-notify-time">每日发送时间<Input id="alert-notify-time" type="time" value={notifyTime} onChange={e=>{setNotifyTime(e.target.value);changed();}} disabled={!editable} required/></label>
          </div><p>到点后发送当天完整采集的数据；采集尚未完成时，完成后再发。采集时间请在“采集设置”中调整。</p></section>
          <section className="alert-card alert-name-filter"><h3>发送前排除商品</h3><label className="alert-field-label" htmlFor="alert-excluded-names">商品名称包含以下任一关键词时不发送</label>
            <textarea id="alert-excluded-names" rows={3} value={excludedNames} onChange={e=>{setExcludedNames(e.target.value);changed();}} disabled={!editable} placeholder="例如：磁吸背盖；多个关键词可换行或用逗号分隔" maxLength={5000}/>
            <p>只筛选钉钉发送名单和预警导出；网页仍按本仓库规则标红。</p>
          </section>
          <section className="alert-send-card" aria-labelledby="alert-send-heading">
            <div className="alert-section-heading"><h3 id="alert-send-heading"><Warehouse size={16}/>{warehouseName} <span>{warehouseCode}</span></h3><Button type="button" variant="ghost" size="sm" onClick={() => void previewOnly()} disabled={busy || previewing || !!pendingRequest}>{previewing ? <LoaderCircle size={14} className="animate-spin"/> : <Eye size={14}/>}预览通知</Button></div>
            <p>发送给：{selectedNames.length ? selectedNames.join("、") : "请先勾选接收群"}</p>
            <p>商品名称显示在编码下方，库存、销售均值和周转分列展示。全部预警合并为一张可折叠卡片；手机点击“7天趋势”查看详情。</p>
            {!saved.exportAvailable && <p>卡片下载按钮需配置可访问的网站地址；这里可直接导出当前预警 Excel。</p>}
            {!saved.cardConfigured && <p className="alert-warning">报表卡片可预览；云端配置卡片模板后启用卡片发送，当前仍发送文字通知。</p>}
            {preview && <div className="alert-preview"><div><strong>符合规则 {preview.eligibleCount} 款 · 排除 {preview.excludedCount} 款 · 发送 {preview.count} 款</strong><span>采集于 {time(preview.capturedAt)}</span></div>{preview.incomplete && <p className="alert-warning">库存采集不完整，暂不能发送。</p>}
              {preview.cards.length ? <><InventoryAlertCardPreview key={cardPart} card={preview.cards[cardPart - 1]}/><div className="alert-card-preview-pages"><Button type="button" variant="outline" size="sm" disabled={cardPart<=1} onClick={()=>setCardPart(p=>p-1)}>上一张</Button><span>{cardPart} / {preview.cards.length} 张 · {preview.cardConfigured ? "原生卡片发送" : "文字发送"}</span><Button type="button" variant="outline" size="sm" disabled={cardPart>=preview.cards.length} onClick={()=>setCardPart(p=>p+1)}>下一张</Button></div></> : <p>{preview.message}</p>}
            </div>}
          </section>
          {result && <div className={`alert-result ${result.groups.some(g => g.state === "unconfirmed" || g.state === "failed") ? "alert-result-warning" : ""}`} role="status"><strong>{result.message}</strong><div>{result.groups.map(g => <span key={g.id}>{g.name} · {g.skipReason === "automatic" ? "已防重" : g.state === "accepted" ? "已受理" : g.state === "failed" ? "发送失败" : g.state === "unconfirmed" ? "未确认" : g.state === "skipped" ? "已跳过" : "等待发送"} {g.acceptedParts}/{g.totalParts}条{g.error && <small>{g.error}</small>}</span>)}</div></div>}
          {feedback && <p className="alert-success" role="status">{feedback}</p>}
          {error && <p className="alert-warning" role="alert">{error}</p>}
          {!result && saved.lastResult && <p className="alert-last-result">上次通知：{saved.lastResult}</p>}
        </div>
        <footer className="alert-dialog-footer"><p>{pendingRequest ? `${pendingRequest.warehouseCode} 结果未确认，查询沿用原请求，不重复发送。` : "立即发送会保存当前设置；同一份数据与自动通知重叠时只投放一次。"}</p><div>
          <Button type="button" variant="outline" onClick={()=>void downloadReport()} disabled={busy || previewing || !!pendingRequest}><ArrowDownToLine size={14}/>{exporting?"导出中…":"导出预警"}</Button>
          <Button type="submit" variant="outline" disabled={busy || previewing || !!pendingRequest}>{saving ? "保存中…" : "保存设置"}</Button>
          <Button type="button" onClick={() => void send()} disabled={busy || previewing || !saved.robotConfigured || !selected.length}>{sending ? <LoaderCircle className="animate-spin"/> : <Send/>}{sending ? "发送中…" : pendingRequest ? "查询发送结果" : "立即发送预警"}</Button>
        </div></footer>
      </form>
    </DialogContent>
  </Dialog>;
}
