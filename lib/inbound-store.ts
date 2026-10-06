import { runtimeDatabase as db } from "./runtime";
import { addQuantity, compareQuantity, subtractQuantity } from "./decimal";
import { collectInbound, type InboundQuery, type InboundReconciliation } from "./inbound";
import { reconciliationDiagnostic } from "./reconciliation-diagnostics";
import { nextDate } from "./daily-sales";

type Pair = { date: string; goods_no: string; unit_name: string; before_id: string; after_id: string; start: string; end: string; before_quantity: string; after_quantity: string };
type Stored = { query_scope: string; goods_no: string; date: string; raw_difference: string; opening_quantity: string; closing_quantity: string; inbound_quantity: string | null; corrected_quantity: string | null; status: InboundReconciliation["status"]; window_start: string; window_end: string; records: string; error: string | null; checked_at: string };
function mapStored(r: Stored): InboundReconciliation {
  const item: InboundReconciliation = { date: r.date, rawDifference: r.raw_difference, openingQuantity: r.opening_quantity, closingQuantity: r.closing_quantity, inboundQuantity: r.inbound_quantity, correctedQuantity: r.corrected_quantity, status: r.query_scope === "warehouse:v1" ? r.status : "failed", windowStart: r.window_start, windowEnd: r.window_end, records: JSON.parse(r.records), error: r.query_scope === "warehouse:v1" ? r.error : "旧记录仅核验单个货品，需重新进行仓库全量入库核验", checkedAt: r.checked_at };
  // Derive the precise explanation for old rows too; no recollection is needed.
  if (item.status !== "verified") item.error = reconciliationDiagnostic(item)?.message ?? item.error;
  return item;
}

export async function loadInboundReconciliations(owner: string, code: string, snapshots: {id:string;date:string}[], goods: string[]) {
  const grouped = new Map<string, Record<string, InboundReconciliation>>();
  const byDate = new Map(snapshots.map(s => [s.date,s.id]));
  const pairs = snapshots.flatMap(s => { const after=byDate.get(nextDate(s.date)); return after ? [[s.id,after]] : []; });
  if (!pairs.length || !goods.length) return grouped;
  // Look up only adjacent baseline pairs, rather than every before/after
  // combination (31 × 31 per product). CROSS JOIN fixes the bounded probe order.
  const result = await db.prepare(`SELECT r.* FROM json_each(?) g CROSS JOIN json_each(?) p
    CROSS JOIN inbound_reconciliations r ON r.owner=? AND r.warehouse_code=? AND r.goods_no=g.value
      AND r.before_snapshot_id=json_extract(p.value,'$[0]') AND r.after_snapshot_id=json_extract(p.value,'$[1]')`)
    .bind(JSON.stringify(goods),JSON.stringify(pairs),owner,code).all<Stored>();
  for (const r of result.results) {
    const dates = grouped.get(r.goods_no) || {};
    dates[r.date] = mapStored(r);
    grouped.set(r.goods_no, dates);
  }
  return grouped;
}
export async function loadCurrentInboundReconciliations(owner: string, code: string, snapshotId: string, goods: string[]) {
  const result = await db.prepare("SELECT r.* FROM inbound_reconciliations r WHERE r.owner=? AND r.warehouse_code=? AND r.after_snapshot_id=? AND r.goods_no IN (SELECT value FROM json_each(?)) AND NOT (EXISTS (SELECT 1 FROM daily_slots d WHERE d.owner=r.owner AND d.warehouse_code=r.warehouse_code AND d.snapshot_id=r.before_snapshot_id) AND EXISTS (SELECT 1 FROM daily_slots d WHERE d.owner=r.owner AND d.warehouse_code=r.warehouse_code AND d.snapshot_id=r.after_snapshot_id)) ORDER BY r.window_start")
    .bind(owner,code,snapshotId,JSON.stringify(goods)).all<Stored>();
  return new Map(result.results.map(r => [r.goods_no,mapStored(r)]));
}

export async function reconcileWarehouseInbound(owner: string, code: string, appkey: string, secret: string,
  progress: (done: number, total: number, requests?: number) => Promise<void>,
  collector: (appkey: string, secret: string, query: InboundQuery, fetcher?: typeof fetch, onPage?: () => Promise<void>) => ReturnType<typeof collectInbound> = collectInbound, currentSnapshotId?: string) {
  // Preserve fixed daily intervals and also reconcile the last capture interval.
  const result = await db.prepare(`WITH latest AS (
    SELECT date FROM stock_snapshots WHERE owner=? AND warehouse_code=? AND status='complete' AND coverage='auto:v1' ORDER BY captured_at DESC,id DESC LIMIT 1
  ), slots AS (
    SELECT d.date,s.id,s.captured_at FROM daily_slots d JOIN stock_snapshots s ON s.id=d.snapshot_id
    WHERE d.owner=? AND d.warehouse_code=? AND s.owner=d.owner AND s.warehouse_code=d.warehouse_code AND s.status='complete' AND s.coverage='auto:v1' AND d.date>=date((SELECT date FROM latest),'-30 day')
    ORDER BY d.date DESC LIMIT 31
  ) SELECT b.date,b.id AS before_id,a.id AS after_id,b.captured_at AS start,a.captured_at AS end,
    e.goods_no,e.unit_name,e.quantity AS before_quantity,f.quantity AS after_quantity
    FROM slots b JOIN slots a ON a.date=date(b.date,'+1 day')
    JOIN stock_entries e ON e.snapshot_id=b.id JOIN stock_entries f ON f.snapshot_id=a.id AND f.goods_no=e.goods_no AND f.unit_name=e.unit_name
    LEFT JOIN inbound_reconciliations r ON r.owner=? AND r.warehouse_code=? AND r.goods_no=e.goods_no AND r.before_snapshot_id=b.id AND r.after_snapshot_id=a.id
    WHERE r.status IS NULL OR r.status<>'verified' OR r.query_scope<>'warehouse:v1' ORDER BY b.date DESC,e.goods_no`).bind(owner, code, owner, code, owner, code).all<Pair>();
  if (currentSnapshotId) {
    // Manual captures outside the fixed daily slots get their own observed
    // interval. These details never enter daily sales, mean or turnover.
    const current = await db.prepare(`WITH current AS (
      SELECT * FROM stock_snapshots s WHERE s.id=? AND s.owner=? AND s.warehouse_code=? AND s.status='complete' AND s.coverage='auto:v1'
    ), previous AS (
      SELECT s.* FROM stock_snapshots s JOIN current c ON s.owner=c.owner AND s.warehouse_code=c.warehouse_code
      WHERE s.status='complete' AND s.coverage='auto:v1' AND s.captured_at<c.captured_at ORDER BY s.captured_at DESC,s.id DESC LIMIT 1
    ) SELECT b.date,b.id AS before_id,a.id AS after_id,b.captured_at AS start,a.captured_at AS end,
      e.goods_no,e.unit_name,e.quantity AS before_quantity,f.quantity AS after_quantity
      FROM previous b JOIN current a JOIN stock_entries e ON e.snapshot_id=b.id
      JOIN stock_entries f ON f.snapshot_id=a.id AND f.goods_no=e.goods_no AND f.unit_name=e.unit_name
      LEFT JOIN inbound_reconciliations r ON r.owner=? AND r.warehouse_code=? AND r.goods_no=e.goods_no AND r.before_snapshot_id=b.id AND r.after_snapshot_id=a.id
      WHERE r.status IS NULL OR r.status<>'verified' OR r.query_scope<>'warehouse:v1'`).bind(currentSnapshotId,owner,code,owner,code).all<Pair>();
    result.results.push(...current.results);
  }
  // Group all comparable goods by snapshot interval. One warehouse query per
  // interval, never one request per goods code. Verified warehouse results are reused.
  const windows = new Map<string, Pair[]>();
  const seen = new Set<string>();
  for (const p of result.results) {
    const key = JSON.stringify([p.before_id,p.after_id]);
    const identity = JSON.stringify([key,p.goods_no]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const list = windows.get(key) || []; list.push(p); windows.set(key,list);
  }
  let done = 0, checked = 0, verified = 0, unresolved = 0, failed = 0, requests = 0;
  await progress(0, windows.size);
  for (const pairs of windows.values()) {
    const window = pairs[0];
    let inbound: Awaited<ReturnType<typeof collectInbound>> | null = null, queryError: string | null = null;
    try {
      inbound = await collector(appkey, secret, { warehouseCode: code, start: window.start, end: window.end }, undefined, () => progress(done, windows.size, ++requests));
    } catch (e) { queryError = e instanceof Error ? e.message : "仓库入库查询失败"; }
    const byGoods = new Map<string, Awaited<ReturnType<typeof collectInbound>>["records"]>();
    for (const record of inbound?.records || []) {
      const list = byGoods.get(record.goodsNo) || []; list.push(record); byGoods.set(record.goodsNo,list);
    }
    const statements = [];
    for (const p of pairs) {
      const raw = subtractQuantity(p.before_quantity, p.after_quantity);
      const records = byGoods.get(p.goods_no) || [];
      let quantity: string | null = null, corrected: string | null = null;
      let status: InboundReconciliation["status"] = "failed", error = queryError;
      if (inbound) {
        if (records.some(r => r.unitName !== p.unit_name)) error = "入库数量单位与库存单位不一致，未直接换算";
        else {
          quantity = records.reduce((sum,r) => addQuantity(sum,r.quantity), "0");
          corrected = addQuantity(raw, quantity);
          // Net sales include signed returns/backfill once the inbound query is complete.
          status = compareQuantity(quantity,"0") >= 0 ? "verified" : "unresolved";
          if (status === "unresolved") error = "入库合计为负，存在入库冲销明细，仍需核对";
        }
      }
      statements.push(db.prepare(`INSERT INTO inbound_reconciliations
        (owner,warehouse_code,goods_no,date,before_snapshot_id,after_snapshot_id,unit_name,raw_difference,opening_quantity,closing_quantity,status,inbound_quantity,corrected_quantity,window_start,window_end,records,error,checked_at,query_scope)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,warehouse_code,goods_no,before_snapshot_id,after_snapshot_id)
        DO UPDATE SET status=excluded.status,inbound_quantity=excluded.inbound_quantity,corrected_quantity=excluded.corrected_quantity,records=excluded.records,error=excluded.error,checked_at=excluded.checked_at,query_scope=excluded.query_scope`)
        .bind(owner,code,p.goods_no,p.date,p.before_id,p.after_id,p.unit_name,raw,p.before_quantity,p.after_quantity,status,quantity,corrected,p.start,p.end,JSON.stringify(records),error?.slice(0,300) ?? null,new Date().toISOString(),"warehouse:v1"));
      if (status === "verified") verified++; else if (status === "unresolved") unresolved++; else failed++;
      checked++;
    }
    for (let offset=0;offset<statements.length;offset+=200) {
      await db.batch(statements.slice(offset,offset+200));
      await progress(done,windows.size,requests);
    }
    done++; await progress(done,windows.size,requests);
  }
  return { checked, windows: done, verified, unresolved, failed };
}
