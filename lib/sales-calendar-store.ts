import { database, requireWarehouse } from "./inventory-store";
import { dailySales, nextDate, reconciledSales } from "./daily-sales";
import { loadInboundReconciliations, loadProvisionalInbound } from "./inbound-store";
import type { SalesCalendarMonth } from "./inventory-types";

// Read one product and at most one month plus the next day's closing baseline.
// History is not limited by the main table's 7/14/30-day display range.
export async function loadSalesCalendar(owner: string, code: string, goodsNo: string, month: string): Promise<SalesCalendarMonth> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < "2000-01" || month > "9998-12") throw new Error("请选择有效月份");
  if (!goodsNo || goodsNo.length > 200) throw new Error("货品编码无效");
  await requireWarehouse(owner, code);
  const db = database(), start = month + "-01";
  const endDate = new Date(start + "T00:00:00Z"); endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  const end = endDate.toISOString().slice(0,10);
  const bounds = await db.prepare(`SELECT MIN(d.date) AS first_date, MAX(d.date) AS last_date
    FROM daily_slots d JOIN stock_snapshots s ON s.id=d.snapshot_id
    WHERE d.owner=? AND d.warehouse_code=? AND s.owner=d.owner AND s.warehouse_code=d.warehouse_code
      AND s.status='complete' AND s.coverage='auto:v1'`).bind(owner,code).first<{first_date:string|null;last_date:string|null}>();
  const slots = await db.prepare(`SELECT s.id,d.date,s.captured_at,e.quantity,e.unit_name FROM daily_slots d
    JOIN stock_snapshots s ON s.id=d.snapshot_id
    LEFT JOIN stock_entries e ON e.snapshot_id=s.id AND e.goods_no=?
    WHERE d.owner=? AND d.warehouse_code=? AND s.owner=d.owner AND s.warehouse_code=d.warehouse_code
      AND s.status='complete' AND s.coverage='auto:v1' AND d.date>=? AND d.date<=? ORDER BY d.date`)
    .bind(goodsNo,owner,code,start,end).all<{id:string;date:string;captured_at:string;quantity:string|null;unit_name:string|null}>();
  const dates:string[] = [];
  for (let date=start;date<end;date=nextDate(date)) dates.push(date);
  const values=slots.results.flatMap(s=>s.quantity != null && s.unit_name != null ? [{date:s.date,quantity:s.quantity,unitName:s.unit_name}] : []);
  const raw = dailySales(values,dates), inbound = (await loadInboundReconciliations(owner,code,slots.results,[goodsNo])).get(goodsNo) || {};
  const sales = reconciledSales(raw,inbound), byDate=new Map(slots.results.map(s=>[s.date,s]));
  const latest=await db.prepare(`SELECT s.id,s.date,s.captured_at,e.quantity,e.unit_name FROM stock_snapshots s
    LEFT JOIN stock_entries e ON e.snapshot_id=s.id AND e.goods_no=?
    WHERE s.owner=? AND s.warehouse_code=? AND s.status='complete' AND s.coverage='auto:v1'
    ORDER BY s.captured_at DESC,s.id DESC LIMIT 1`).bind(goodsNo,owner,code)
    .first<{id:string;date:string;captured_at:string;quantity:string|null;unit_name:string|null}>();
  // A new calendar day before the next daily collection still belongs to the
  // preceding open interval. Tomorrow's fixed baseline always takes priority.
  const opening=slots.results.findLast(s=>latest && (s.date===latest.date || nextDate(s.date)===latest.date) && !byDate.has(nextDate(s.date)));
  const provisional=opening && latest && opening.date>=start && opening.date<end && opening.captured_at<latest.captured_at
    && opening.quantity!=null && latest.quantity!=null && opening.unit_name!=null && latest.unit_name===opening.unit_name
    ? await loadProvisionalInbound(owner,code,goodsNo,{...opening,quantity:opening.quantity,unit_name:opening.unit_name},
      {...latest,quantity:latest.quantity,unit_name:latest.unit_name}) : null;
  return {month, firstMonth:bounds?.first_date?.slice(0,7) || month, lastMonth:bounds?.last_date?.slice(0,7) || month,
    days:dates.map(date=>{
      const before=byDate.get(date),after=byDate.get(nextDate(date));
      if(provisional?.date===date) return {date,provisional:true,sales:provisional.correctedQuantity,
        openingQuantity:provisional.openingQuantity,closingQuantity:provisional.closingQuantity,
        windowStart:provisional.windowStart,windowEnd:provisional.windowEnd,correction:provisional};
      return {date,sales:sales[date],openingQuantity:before?.quantity ?? null,closingQuantity:after?.quantity ?? null,
        windowStart:before?.captured_at ?? null,windowEnd:after?.captured_at ?? null,correction:inbound[date]};
    })};
}
