import assert from "node:assert/strict";
import test from "node:test";
import { collectInbound, inboundTime, type InboundReconciliation } from "../lib/inbound";
import { reconciledSales, dailySales } from "../lib/daily-sales";
import { inventoryMetrics } from "../lib/inventory-metrics";
import { reconciliationDiagnostic } from "../lib/reconciliation-diagnostics";

const query = { warehouseCode: "CK031", goodsNo: "C.Q.CB.AP.00.0636", unitName: "Pcs", start: "2026-10-02T00:00:23.946Z", end: "2026-10-03T00:00:23.670Z" };
const record = (id = "2267542", quantity = "500", date = "1790922543000") => ({ recId: id, docId: "1038047", goodsdocNo: "CRK202610022053", goodsNo: query.goodsNo, warehouseCode: query.warehouseCode, quantity, inOutDate: date, gmtCreate: date, skuBarcode: query.goodsNo, unitName: "Pcs", inouttypeName: "调拨入库" });
const reply = (data: unknown) => Response.json({ code: 200, subCode: "0250000004", result: { data, noPrivilegeItem: null } });

test("负库存与退货回补保留符号，完整入库核验后显示负净销量",()=>{
  const base: InboundReconciliation={date:"2026-10-02",rawDifference:"-151",openingQuantity:"-4",closingQuantity:"147",inboundQuantity:"150",correctedQuantity:"-1",status:"verified",windowStart:query.start,windowEnd:query.end,records:[],error:"旧的笼统提示",checkedAt:query.end};
  const result=reconciliationDiagnostic(base)!;
  assert.equal(result.difference,"-1"); assert.equal(result.increase,"1");
  assert.equal(result.kind,"net_return"); assert.match(result.message,/计入近7天销量均值/);
  assert.doesNotMatch(result.message,/冲销/);
  assert.equal(reconciledSales({[base.date]:"-151"},{[base.date]:base})[base.date],"-1");
  const missing={...base,openingQuantity:"58",closingQuantity:"59",rawDifference:"-1",inboundQuantity:"0"};
  assert.equal(reconciledSales({[base.date]:"-1"},{[base.date]:missing})[base.date],"-1");
  const returned={...base,openingQuantity:"100",closingQuantity:"102",rawDifference:"-2",inboundQuantity:"0",correctedQuantity:"-2"};
  assert.equal(reconciledSales({[base.date]:"-2"},{[base.date]:returned})[base.date],"-2");
  const negative={...base,openingQuantity:"-3",closingQuantity:"-4",rawDifference:"1",inboundQuantity:"0",correctedQuantity:"1",status:"verified" as const};
  assert.deepEqual(dailySales([{date:"2026-10-02",quantity:"-3",unitName:"Pcs"},{date:"2026-10-03",quantity:"-4",unitName:"Pcs"}],[base.date]),{[base.date]:"1"});
  assert.equal(reconciledSales({[base.date]:"1"},{[base.date]:negative})[base.date],"1");
  assert.equal(reconciliationDiagnostic(negative),null);
  // Fully offset the -4 opening balance: -4 + 150 - 146 = 0.
  assert.equal(reconciliationDiagnostic({...base,closingQuantity:"146",rawDifference:"-150",correctedQuantity:"0",status:"verified"}),null);
  assert.equal(reconciliationDiagnostic({...base,status:"failed"}),null,"查询失败不能视为已核验回补");
  assert.equal(reconciliationDiagnostic({...base,inboundQuantity:null}),null);
  assert.equal(reconciliationDiagnostic({...base,rawDifference:"-150"}),null,"不使用与库存不匹配的结果");
  assert.equal(reconciliationDiagnostic({...base,correctedQuantity:"0"}),null,"拒绝不一致核算");
  assert.equal(reconciliationDiagnostic({...base,openingQuantity:"10",closingQuantity:"10",rawDifference:"0",inboundQuantity:"-2",correctedQuantity:"-2"})!.kind,"inbound_reversal");
});

test("真实响应的成功subCode不会抹掉500入库；查询归档、分页、去重和精确采集边界", async () => {
  const requests: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (_url, options) => {
    const params = new URLSearchParams(String(options!.body));
    assert.equal(params.get("method"), "erp-busiorder.goodsdocin.search");
    const input = JSON.parse(params.get("bizcontent")!); requests.push(input);
    assert.equal(input.goodsNo, query.goodsNo); assert.equal(input.warehouseCode, query.warehouseCode);
    assert.equal(input.inOutDateStart, "2026-10-02 08:00:23"); assert.equal(input.inOutDateEnd, "2026-10-03 08:00:24");
    if (input.pageIndex > 0) return reply([]);
    return reply(input.archived === 0 ? [record(), record("start", "100", String(Date.parse(query.start))), record("end", "0.25", String(Date.parse(query.end))), record("late", "200", String(Date.parse(query.end) + 1))] : [record(), record("archived", "0.5")]);
  };
  const result = await collectInbound("key", "secret", query, fetcher);
  assert.equal(result.quantity, "500.75"); assert.equal(result.records.length, 3);
  assert.equal(result.records.find(r => r.recId === "2267542")!.inOutDate, "2026-10-02T06:29:03.000Z");
  assert.deepEqual(requests.map(r => [r.archived, r.pageIndex]), [[0,0],[0,1],[1,0],[1,1]]);
  assert.equal(inboundTime("2026-10-02 14:29:03"), "2026-10-02T06:29:03.000Z");
});

test("非JSON、订阅权限、错仓库/货品、错单位、数量缺失均不会变成零入库", async () => {
  await assert.rejects(collectInbound("k","s",query,async () => new Response("<!DOCTYPE html>")), /非 JSON/);
  await assert.rejects(collectInbound("k","s",query,async () => Response.json({code:400,subCode:"0130020310",message:"secret never echoed"})), /0130020310/);
  await assert.rejects(collectInbound("k","s",query,async () => Response.json({code:200,result:{data:[],noPrivilegeItem:["quantity"]}})), /权限/);
  for (const changed of [{warehouseCode:"OTHER"},{goodsNo:"wrong"},{unitName:"箱"},{quantity:undefined},{inOutDate:"bad"}]) {
    await assert.rejects(collectInbound("k","s",query,async (_url, options) => {
      const input=JSON.parse(new URLSearchParams(String(options!.body)).get("bizcontent")!);
      return reply(input.pageIndex ? [] : [{...record(),...changed}]);
    }));
  }
  await assert.rejects(collectInbound("k","s",query,async (_url, options) => {
    const input=JSON.parse(new URLSearchParams(String(options!.body)).get("bizcontent")!);
    return input.archived ? new Response("unavailable",{status:403}) : reply(input.pageIndex ? [] : [record()]);
  }), /HTTP 403/);
});

test("重复分页/冲突明细拒绝发布，完整空结果才可认定入库合计0",async()=>{
  await assert.rejects(collectInbound("k","s",query,async()=>reply([record()])),/完全重复/);
  await assert.rejects(collectInbound("k","s",query,async (_url,options)=>{
    const input=JSON.parse(new URLSearchParams(String(options!.body)).get("bizcontent")!);
    return reply(input.pageIndex ? [] : [record("same",input.archived ? "499" : "500")]);
  }),/冲突/);
  const empty=await collectInbound("k","s",query,async()=>reply([]));
  assert.equal(empty.quantity,"0"); assert.deepEqual(empty.records,[]);
});

test("修正-499为1，缺失/失败结果不冒充销量，7天均值周转使用修正值",()=>{
  const correction: InboundReconciliation = { date:"2026-10-02",rawDifference:"-499",openingQuantity:"28",closingQuantity:"527",inboundQuantity:"500",correctedQuantity:"1",status:"verified",windowStart:query.start,windowEnd:query.end,records:[],error:null,checkedAt:query.end };
  assert.deepEqual(reconciledSales({"2026-10-02":"-499","2026-10-03":"15"},{"2026-10-02":correction}),{"2026-10-02":"1","2026-10-03":null});
  assert.equal(reconciledSales({"2026-10-02":"-499"},{})["2026-10-02"],null);
  assert.equal(reconciledSales({"2026-10-02":"-499"},{"2026-10-02":{...correction,status:"failed"}})["2026-10-02"],null);
  assert.equal(reconciledSales({"2026-10-02":"-499"},{"2026-10-02":{...correction,rawDifference:"-498"}})["2026-10-02"],null);
  const values=Array.from({length:8},(_,i)=>({date:`2026-10-0${i+1}`,quantity:String(i<2?28:527-(i-2)*2),unitName:"Pcs"}));
  const completed: Record<string,InboundReconciliation>=Object.fromEntries(Object.entries(dailySales(values,["2026-10-01","2026-10-02","2026-10-03","2026-10-04","2026-10-05","2026-10-06","2026-10-07"])).map(([date,q])=>[date,{...correction,date,rawDifference:q!,inboundQuantity:"0",correctedQuantity:q!}]));
  completed["2026-10-02"]=correction;
  const metric=inventoryMetrics(values,"2026-10-08","70","Pcs",completed);
  assert.equal(metric.average7,"1.57"); assert.equal(metric.turnoverDays,"44.55"); assert.equal(metric.basis,"inbound_adjusted_difference");
  assert.equal(inventoryMetrics(values,"2026-10-08","70","Pcs").reason,"inbound_unverified");
});


test("仓库全量查询不传goodsNo，跨页跨货品归档记录按身份去重",async()=>{
  const requests:Record<string,unknown>[]=[];
  const result=await collectInbound("k","s",{warehouseCode:query.warehouseCode,start:query.start,end:query.end},async(_url,options)=>{
    const input=JSON.parse(new URLSearchParams(String(options!.body)).get("bizcontent")!);requests.push(input);
    assert.equal(Object.hasOwn(input,"goodsNo"),false);assert.equal(input.warehouseCode,"CK031");
    if(input.archived===0 && input.pageIndex===0)return reply([record(),{...record("other1","10"),goodsNo:"OTHER"}]);
    if(input.archived===0 && input.pageIndex===1)return reply([{...record("other2","20"),goodsNo:"OTHER"}]);
    if(input.archived===1 && input.pageIndex===0)return reply([record(),{...record("archive","2"),goodsNo:"ARCHIVE",unitName:"箱"}]);
    return reply([]);
  });
  assert.equal(result.records.length,4);assert.equal(result.records.filter(r=>r.goodsNo==="OTHER").length,2);
  assert.deepEqual(requests.map(r=>[r.archived,r.pageIndex]),[[0,0],[0,1],[0,2],[1,0],[1,1]]);
  assert.equal(reconciledSales({day:"10"},{})["day"],null,"正差额也必须等待全仓入库核验");
});
