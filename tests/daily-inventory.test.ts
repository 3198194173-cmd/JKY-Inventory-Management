import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { comparableDates, dailySales, type DailyValue } from "../lib/daily-sales";
import { collectWarehouseStock, discoverCatalog, fetchCatalogPage } from "../lib/warehouse-collector";
import { addQuantity, subtractQuantity, compareQuantity } from "../lib/decimal";
import { createAccumulator, accumulatePage } from "../lib/stock-aggregation";
import { inventoryMetrics as calculateMetrics, recentSalesDates } from "../lib/inventory-metrics";
import { divideQuantity } from "../lib/decimal";

// These calculation fixtures explicitly model a completed warehouse query with no inbound.
function inventoryMetrics(values: DailyValue[], asOf: string, stock: string, unit: string) {
  const raw=dailySales(values,recentSalesDates(asOf),unit);
  const corrections=Object.fromEntries(Object.entries(raw).filter(([,q])=>q!=null).map(([date,q])=>[date,{date,rawDifference:q!,openingQuantity:"0",closingQuantity:"0",inboundQuantity:"0",correctedQuantity:q!,status:"verified" as const,windowStart:"",windowEnd:"",records:[],error:null,checkedAt:""}]));
  return calculateMetrics(values,asOf,stock,unit,corrections);
}
const catalogRow = (id = "1",code = "CK_ALT") => ({quantityId:id,skuId:id,skuBarcode:`b${id}`,goodsNo:`g${id}`,goodsName:`货品${id}`,unitName:"Pcs",ownerName:"货主",warehouseId:"9999999999999999999",warehouseCode:code,warehouseName:"测试仓"});

test("近7天均值固定除7，周转使用最新库存及未舍入均值", () => {
  const values = Array.from({length:8},(_,i)=>({date:`2026-10-0${i+1}`,quantity:String(20-i),unitName:"Pcs"}));
  const metric = inventoryMetrics(values,"2026-10-08","10","Pcs");
  assert.equal(metric.average7,"1"); assert.equal(metric.turnoverDays,"10"); assert.equal(metric.validDays,7);
  const fractional = values.map((v,i)=>({...v,quantity:i === 0 ? "21" : "20"}));
  const rounded = inventoryMetrics(fractional,"2026-10-08","10","Pcs");
  assert.equal(rounded.average7,"0.14"); assert.equal(rounded.turnoverDays,"70");
  assert.deepEqual(recentSalesDates("2027-01-03"),["2027-01-02","2027-01-01","2026-12-31","2026-12-30","2026-12-29","2026-12-28","2026-12-27"]);
  assert.equal(divideQuantity("12345678901234567890.7","7"),"1763668414462081127.24");
  assert.equal(divideQuantity("1.005","1"),"1.01");
  assert.throws(()=>divideQuantity("1","0"),/除以零/);
});

test("缺日、单位变化、零消耗和负库存不伪造周转", () => {
  const values = Array.from({length:8},(_,i)=>({date:`2026-10-0${i+1}`,quantity:String(20-i),unitName:"Pcs"}));
  const missing = inventoryMetrics(values.filter((_,i)=>i!==3),"2026-10-08","10","Pcs");
  assert.equal(missing.average7,null); assert.equal(missing.reason,"insufficient_data"); assert.equal(missing.validDays,5);
  assert.equal(inventoryMetrics(values.map((v,i)=>i===3?{...v,unitName:"Box"}:v),"2026-10-08","10","Pcs").reason,"insufficient_data");
  const inbound = inventoryMetrics(values.map((v,i)=>i===3?{...v,quantity:"519"}:v),"2026-10-08","10","Pcs");
  assert.equal(inbound.average7,"1"); assert.equal(inbound.turnoverDays,"10"); assert.equal(inbound.validDays,7);
  const zero = inventoryMetrics(values.map(v=>({...v,quantity:"20"})),"2026-10-08","10","Pcs");
  assert.equal(zero.average7,"0"); assert.equal(zero.turnoverDays,null); assert.equal(zero.reason,"no_consumption");
  assert.equal(inventoryMetrics(values,"2026-10-08","0","Pcs").turnoverDays,"0");
  assert.equal(inventoryMetrics(values,"2026-10-08","-1","Pcs").reason,"negative_inventory");
});
test("昨日销量准确保留小数、负数、零和长数量精度", () => {
  assert.equal(subtractQuantity("9007199254740990.5","9007199254740989.2"),"1.3");
  const values = ["5.2","3.1","7.6","7.6"].map((q,i) => ({date:`2026-09-${26+i}`,quantity:q,unitName:"Pcs"}));
  assert.deepEqual(dailySales(values,["2026-09-26","2026-09-27","2026-09-28"]),{"2026-09-26":"2.1","2026-09-27":"-4.5","2026-09-28":"0"});
});

test("退货负净销量计入7天均值，非正均值不计算周转", () => {
  function fixture(sales: string[]) {
    let stock="100";
    const values=[{date:"2026-10-01",quantity:stock,unitName:"Pcs"}];
    for (let i=0;i<sales.length;i++) {
      stock=subtractQuantity(stock,sales[i]);
      values.push({date:`2026-10-0${i+2}`,quantity:stock,unitName:"Pcs"});
    }
    return values;
  }
  const mixed=inventoryMetrics(fixture(["10","-2","5","0","1","2","-1"]),"2026-10-08","100","Pcs");
  assert.equal(mixed.average7,"2.14");assert.equal(mixed.turnoverDays,"46.67");assert.equal(mixed.validDays,7);
  const negative=inventoryMetrics(fixture(["0","-2","0","0","0","0","0"]),"2026-10-08","102","Pcs");
  assert.equal(negative.average7,"-0.29");assert.equal(negative.turnoverDays,null);assert.equal(negative.reason,"net_returns");
  const zero=inventoryMetrics(fixture(["2","-2","0","0","0","0","0"]),"2026-10-08","100","Pcs");
  assert.equal(zero.average7,"0");assert.equal(zero.turnoverDays,null);assert.equal(zero.reason,"no_consumption");
  const tiny=inventoryMetrics(fixture(["-0.01","0","0","0","0","0","0"]),"2026-10-08","100","Pcs");
  assert.equal(tiny.reason,"net_returns");assert.equal(tiny.turnoverDays,null,"使用未舍入的总量判断，不能因显示0计算周转");
});
test("无采集、首日、缺日期、新 SKU 和单位变化不会伪造销售", () => {
  assert.deepEqual(comparableDates([]),[]); assert.deepEqual(comparableDates(["2026-09-29"]),[]);
  assert.deepEqual(comparableDates(["2026-09-26","2026-09-28","2026-09-29"]),["2026-09-28"]);
  assert.deepEqual(comparableDates(["2026-12-31","2027-01-01"]),["2026-12-31"]);
  assert.equal(dailySales([{date:"2026-09-28",quantity:"5",unitName:"Pcs"},{date:"2026-09-30",quantity:"2",unitName:"Pcs"}],["2026-09-28"])["2026-09-28"],null);
  assert.equal(dailySales([{date:"2026-09-28",quantity:"5",unitName:"Pcs"},{date:"2026-09-29",quantity:"2",unitName:"Box"}],["2026-09-28"])["2026-09-28"],null);
  assert.equal(dailySales([{date:"2026-09-29",quantity:"0",unitName:"Pcs"}],["2026-09-28"])["2026-09-28"],null);
  assert.equal(dailySales([{date:"2026-09-28",quantity:"5",unitName:"Box"},{date:"2026-09-29",quantity:"2",unitName:"Box"}],["2026-09-28"],"Pcs")["2026-09-28"],null);
});
test("仓库代码透传目录接口，空终页而非 total=0 决定分页结束", async () => {
  const fetcher = (async(_url, options) => {
    const form = new URLSearchParams(String(options?.body)), biz = JSON.parse(form.get("bizcontent")!);
    assert.equal(form.get("method"),"erp.stockquantity.get"); assert.equal(biz.warehouseCode,"CK_ALT"); assert.equal(biz.pageSize,200); assert.equal(biz.isBlockup,"1");
    return Response.json({code:200,result:{data:{goodsStockQuantity:[]},pageInfo:{total:0}}});
  }) as typeof fetch;
  assert.deepEqual(await fetchCatalogPage("fake","fake","CK_ALT",0,fetcher),[]);
  const calls: unknown[] = [];
  const catalog = await discoverCatalog("fake","fake","CK_ALT",async() => {}, async(_a,_s,_c,page,_fetch,cursor) => { calls.push([page,cursor]); return cursor === "0" ? [catalogRow()] : []; });
  assert.deepEqual(calls,[[0,"0"],[0,"1"]]); assert.equal(catalog.rows.length,1);
  await assert.rejects(() => discoverCatalog("fake","fake","CK_ALT",async() => {},async() => [catalogRow()]),/游标/);
  await assert.rejects(() => discoverCatalog("fake","fake","CK_ALT",async() => {},async() => [catalogRow("1","CK_OTHER")]),/其他仓库/);
});
test("两接口自动衔接使用可购数量，校验规格和货主，无需人工范围", async () => {
  const catalogue = async(_a:string,_s:string,_c:string,_page:number,_fetch?:typeof fetch,cursor?:string) => cursor === "0" ? [catalogRow("1"),catalogRow("2")] : [];
  const stock = async(_a:string,_s:string,page:number,_f?:typeof fetch,_batch?:string[],code?:string) => {
    assert.equal(code,"CK_ALT"); const first = {...catalogRow("1"),currentQuantity:"777",orderAbleQuantity:"0.2"} as Record<string,unknown>; delete first.ownerName; return page === 0 ? [first,{...catalogRow("2"),orderAbleQuantity:"-1"}] : [];
  };
  const result = await collectWarehouseStock("fake","fake","CK_ALT",async() => {},catalogue,stock);
  assert.equal(result.rows[0].quantity,"0.2"); assert.equal(result.rows[1].quantity,"-1"); assert.equal(result.pageCount,4);
  await assert.rejects(() => collectWarehouseStock("fake","fake","CK_ALT",async() => {},catalogue,stock,"different-registered-id"),/身份已改变/);
  await assert.rejects(() => collectWarehouseStock("fake","fake","CK_ALT",async() => {},catalogue,async(_a,_s,page,_f,_b,_c,goodsNo) => !goodsNo && page === 0 ? [{...catalogRow("1"),orderAbleQuantity:"0"}] : []),/未返回/);
  await assert.rejects(() => collectWarehouseStock("fake","fake","CK_ALT",async() => {},catalogue,async() => [{...catalogRow("1"),ownerName:"错误货主",orderAbleQuantity:"0"}]),/货主/);
  const state = createAccumulator(); accumulatePage(state,[{...catalogRow(),orderAbleQuantity:"5"}],"测试仓","9999999999999999999");
  assert.throws(() => accumulatePage(createAccumulator(),[{...catalogRow(),orderAbleQuantity:"5"}],"测试仓","other"),/仓库身份/);
});
test("同规格重复行的可选货主字段不会导致库存重复求和", async () => {
  const catalog = async(_a:string,_s:string,_c:string,_page:number,_fetch?:typeof fetch,cursor?:string) => cursor === "0" ? [catalogRow()] : [];
  const stock = async(_a:string,_s:string,page:number) => {
    const missing = {...catalogRow(),orderAbleQuantity:"10"} as Record<string,unknown>; delete missing.ownerName;
    return page === 0 ? [missing,{...catalogRow(),orderAbleQuantity:"10"}] : [];
  };
  const result = await collectWarehouseStock("fake","fake","CK_ALT",async() => {},catalog,stock);
  assert.equal(result.recordCount,1); assert.equal(result.duplicateCount,1); assert.equal(result.rows[0].quantity,"10");
});
test("无条码规格通过货品编码查询，仍按SKU身份核验数量", async () => {
  const missing = {...catalogRow("2"),skuBarcode:null};
  const catalog = async(_a:string,_s:string,_c:string,_p:number,_f?:typeof fetch,cursor?:string) => cursor === "0" ? [catalogRow("1"),missing] : [];
  const calls: string[] = [];
  const stock = async(_a:string,_s:string,page:number,_f?:typeof fetch,_b?:string[],code?:string,goodsNo?:string) => {
    assert.equal(code,"CK_ALT"); calls.push(goodsNo || "barcode");
    return page ? [] : goodsNo ? [{...missing,orderAbleQuantity:"2.5"}] : [{...catalogRow("1"),orderAbleQuantity:"1"}];
  };
  const result = await collectWarehouseStock("fake","fake","CK_ALT",async()=>{},catalog,stock);
  assert.deepEqual(result.rows.map(r=>r.quantity),["1","2.5"]); assert.equal(result.unavailable.length,0);
  assert.deepEqual(calls,["barcode","barcode","g2","g2"]);
});
test("未返回库存明确保留清单，不补零；缺一个规格不显示货品的部分合计", async () => {
  const missing = {...catalogRow("3"),goodsNo:"g2",goodsName:"货品2",skuBarcode:null};
  const catalog = async(_a:string,_s:string,_c:string,_p:number,_f?:typeof fetch,cursor?:string) => cursor === "0" ? [catalogRow("1"),catalogRow("2"),missing] : [];
  const stock = async(_a:string,_s:string,page:number,_f?:typeof fetch,_b?:string[],_c?:string,goodsNo?:string) => page || goodsNo ? [] : [{...catalogRow("1"),orderAbleQuantity:"7"},{...catalogRow("2"),orderAbleQuantity:"10"}];
  const result = await collectWarehouseStock("fake","fake","CK_ALT",async()=>{},catalog,stock,undefined,true);
  assert.equal(result.recordCount,2); assert.deepEqual(result.rows.map(r=>[r.goodsNo,r.quantity]),[["g1","7"]]);
  assert.equal(result.unavailable[0].skuId,"3"); assert.equal(result.unavailable[0].skuBarcode,""); assert.match(result.unavailable[0].reason,/无条码/);
  await assert.rejects(()=>collectWarehouseStock("fake","fake","CK_ALT",async()=>{},catalog,stock),/未返回/);
  await assert.rejects(()=>collectWarehouseStock("fake","fake","CK_ALT",async()=>{},catalog,async()=>[],undefined,true),/任何可核验/);
});
test("游标覆盖一万条以上清单，并拒绝忽略游标或乱序", async () => {
  const catalog = await discoverCatalog("fake","fake","CK_ALT",async()=>{},async(_a,_s,_c,page,_f,cursor) => {
    assert.equal(page,0); const after=Number(cursor); return after >= 10200 ? [] : Array.from({length:200},(_,i)=>catalogRow(String(after+i+1)));
  });
  assert.equal(catalog.rows.length,10200); assert.equal(catalog.pageCount,52);
  await assert.rejects(()=>discoverCatalog("fake","fake","CK_ALT",async()=>{},async()=>[catalogRow("2"),catalogRow("1")]),/游标/);
});
test("迁移保存旧数据，多仓库隔离、每日基准不覆盖、1000条查询少量绑定", () => {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync("drizzle").filter(n => n.endsWith(".sql")).sort()) db.exec(readFileSync(`drizzle/${name}`,"utf8"));
  db.prepare("INSERT INTO warehouses (owner,code,name,created_at) VALUES ('owner','CK_ALT','测试','now')").run();
  assert.equal(db.prepare("SELECT daily_time, time_zone FROM warehouses").get()!.daily_time,"08:00");
  assert.ok(db.prepare("PRAGMA table_info(stock_snapshots)").all().some(row=>row.name === "unavailable_skus"));
  assert.ok(db.prepare("PRAGMA table_info(sync_runs)").all().some(row=>row.name === "last_progress_at"));
  db.exec("INSERT INTO stock_snapshots (id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,coverage) VALUES ('first','owner','2026-09-28','t1','complete',1,1000,1000,'{}',0,0,'CK_ALT','auto:v1'), ('later','owner','2026-09-28','t2','complete',1,1,1,'{}',0,0,'CK_ALT','auto:v1'), ('other','owner','2026-09-28','t3','complete',1,1,1,'{}',0,0,'CK_OTHER','auto:v1')");
  db.prepare("INSERT OR IGNORE INTO daily_slots VALUES ('owner','CK_ALT','2026-09-28',?)").run("first"); db.prepare("INSERT OR IGNORE INTO daily_slots VALUES ('owner','CK_ALT','2026-09-28',?)").run("later");
  assert.equal(db.prepare("SELECT snapshot_id FROM daily_slots").get()!.snapshot_id,"first");
  const quantities = ["-100","-10","-2.3","-2","-0.1","0","0.1","2","2.3","10","100","9007199254740990.5"];
  const entries = Array.from({length:1000},(_,i) => [`g${i}`,"测试","Pcs",quantities[i % quantities.length],1,compareQuantity(quantities[i % quantities.length],"0")]);
  db.prepare("INSERT INTO stock_entries SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),json_extract(value,'$[4]'),json_extract(value,'$[5]') FROM json_each(?)").run("first",JSON.stringify(entries));
  const history = db.prepare("SELECT e.* FROM stock_entries e JOIN stock_snapshots s ON s.id = e.snapshot_id WHERE s.owner = ? AND e.snapshot_id IN (SELECT value FROM json_each(?)) AND e.goods_no IN (SELECT value FROM json_each(?))").all("owner",JSON.stringify(["first"]),JSON.stringify(entries.map(e => e[0])));
  assert.equal(history.length,1000);
  for (const asc of [true,false]) {
    const sort = `sign ${asc ? "ASC" : "DESC"}, CASE WHEN sign > 0 THEN instr(quantity || '.', '.') - 1 WHEN sign < 0 THEN 2 - instr(quantity || '.', '.') ELSE 0 END ${asc ? "ASC" : "DESC"}, CASE WHEN sign > 0 THEN quantity END COLLATE BINARY ${asc ? "ASC" : "DESC"}, CASE WHEN sign < 0 THEN substr(quantity, 2) END COLLATE BINARY ${asc ? "DESC" : "ASC"}, goods_no COLLATE BINARY ASC`;
    const result = db.prepare(`SELECT quantity FROM stock_entries WHERE snapshot_id = 'first' ORDER BY ${sort}`).all();
    for (let i=1;i<result.length;i++) assert.ok(compareQuantity(String(result[i-1].quantity),String(result[i].quantity)) * (asc ? 1 : -1) <= 0);
  }
  assert.equal(addQuantity("0.1","0.2"),"0.3"); db.close();
});
