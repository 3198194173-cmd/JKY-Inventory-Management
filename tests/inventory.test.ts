import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { addQuantity,normalizeQuantity } from "../lib/decimal";
import { createAccumulator,accumulatePage,aggregatedRows } from "../lib/stock-aggregation";
import { collectStock,fetchStockPage,jackyunSign,WAREHOUSE_NAME } from "../lib/jackyun";
import { parseLosslessJson } from "../lib/lossless-json";
import { sendRobotMessage,alertDigest,alertRows } from "../lib/dingtalk";
import { sampleView } from "../lib/sample";
import { inventoryWorkbook } from "../lib/excel";
import { stockScope, barcodeBatches } from "../lib/stock-scope";

const row = (skuId="1",quantity:unknown="0.1") => ({goodsNo:"G001",goodsName:"货品",skuId,skuBarcode:skuId,warehouseId:"2391620541187785472",warehouseName:WAREHOUSE_NAME,unitName:"Pcs",orderAbleQuantity:quantity});
test("固定向量：吉客云签名使用小写原文而不是编码后文本",()=>{
  const params={appkey:"92058521",bizcontent:'{"pageIndex":0,"pageSize":1000,"warehouseCode":"CK031","cols":"orderAbleQuantity"}',contenttype:"json",method:"erp-stock.stock.skulist",timestamp:"2026-09-28 12:34:56",version:"v1.0"};
  assert.equal(jackyunSign(params,"UnitTestSecret_ABC123"),"4160951e0cb1e22df4e79171956e3475");
});
test("数量和长 ID 保留原始数字精度，字符串不被改写",()=>{
  const parsed=parseLosslessJson('{"id":2391620541187785472,"q":9007199254740990.5,"quoted":"123 \\"test\\"","tiny":1e-7}') as Record<string,string>;
  assert.equal(parsed.id,"2391620541187785472"); assert.equal(parsed.q,"9007199254740990.5"); assert.equal(parsed.quoted,'123 "test"'); assert.equal(normalizeQuantity(parsed.tiny),"0.0000001");
  assert.equal(addQuantity("0.1","0.2"),"0.3"); assert.equal(addQuantity("-0.5","0.2"),"-0.3");
});
test("同货品不同规格求和，重复页不重复计入",()=>{
  const state=createAccumulator(); accumulatePage(state,[row("1"),row("2","0.2")],WAREHOUSE_NAME);
  assert.equal(aggregatedRows(state)[0].quantity,"0.3"); assert.equal(accumulatePage(state,[row("1")],WAREHOUSE_NAME),0); assert.equal(aggregatedRows(state)[0].quantity,"0.3");
  assert.throws(()=>accumulatePage(state,[row("1","8")],WAREHOUSE_NAME),/冲突/);
  assert.throws(()=>accumulatePage(createAccumulator(),[{...row(),warehouseId:"other"}],WAREHOUSE_NAME),/仓库身份/);
  const ownerState=createAccumulator(); accumulatePage(ownerState,[{...row(),ownerName:"A"},{...row(),ownerName:"B"}],WAREHOUSE_NAME); assert.equal(aggregatedRows(ownerState)[0].quantity,"0.2");
});
test("分页必须查至空页，且清单每个条码都要返回",async()=>{
  const pages:number[]=[];
  const result=await collectStock("fake","fake",async()=>{},async(_a,_s,page)=>{pages.push(page);return page===0?[row("1")]:page===1?[row("2","0.2")]:[];},stockScope("1\n2"));
  assert.deepEqual(pages,[0,1,2]); assert.equal(result.recordCount,2); assert.equal(result.rows[0].quantity,"0.3");
  await assert.rejects(()=>collectStock("fake","fake",async()=>{},async()=>[row()],stockScope("1")),/完全重复/);
  await assert.rejects(()=>collectStock("fake","fake",async()=>{},async(_a,_s,page)=>page===0?[row()]:[],stockScope("1\n2")),/条码未返回/);
  await assert.rejects(()=>collectStock("fake","fake",async()=>{},async()=>[row("outside")],stockScope("1")),/清单以外/);
  await assert.rejects(()=>collectStock("fake","fake",async()=>{}),/仅按仓库/);
});
test("清单去重后分批，超过1000条不会由单请求隐式截断",async()=>{
  const scope=stockScope(Array.from({length:7001},(_,i)=>`b${i}`).join("\n")+"\nb0");
  assert.equal(scope.barcodes.length,7001);assert.ok(barcodeBatches(scope).length>15);assert.ok(barcodeBatches(scope).every(b=>b.length<=500 && b.join(',').length<=1000));
  assert.equal(stockScope("b1\nb0").key,stockScope("b0,b1,b0").key);
  const requests:string[][]=[];
  const result=await collectStock("fake","fake",async()=>{},async(_a,_s,page,_f,batch)=>{if(page===0)requests.push(batch!);return batch!.slice(page*200,(page+1)*200).map(id=>({...row(id,"0"),goodsNo:id,goodsName:`货品 ${id}`}));},scope);
  assert.equal(result.recordCount,7001);assert.equal(result.rows.length,7001);assert.equal(requests.length,barcodeBatches(scope).length);
});
test("只在显式条码范围内接受已实测的成功null终页，权限受限仍失败",async()=>{
  const empty=(async()=>Response.json({code:200,subCode:"0250000004",result:{data:null,noPrivilegeItem:null}})) as typeof fetch;
  assert.deepEqual(await fetchStockPage("fake","fake",1,empty,["b1"]),[]);
  await assert.rejects(()=>fetchStockPage("fake","fake",1,empty),/result.data/);
  await assert.rejects(()=>fetchStockPage("fake","fake",1,(async()=>Response.json({code:200,subCode:"0250000004",result:{data:null,noPrivilegeItem:["orderAbleQuantity"]}})) as typeof fetch,["b1"]),/权限/);
});
test("表单业务参数保留大小写，并正确读取可订购量",async()=>{
  let called=0;
  const fetcher=(async(url,options)=>{called++;assert.equal(url,"https://open.jackyun.com/open/openapi/do");const form=new URLSearchParams(String(options?.body));const biz=JSON.parse(form.get("bizcontent")!);assert.equal(biz.warehouseCode,"CK031");assert.equal(biz.pageIndex,0);assert.equal(biz.pageSize,200);assert.match(biz.cols,/orderAbleQuantity/);return new Response('{"code":200,"result":{"data":[{"orderAbleQuantity":9007199254740990.5}]}}');}) as typeof fetch;
  const data=await fetchStockPage("fake","fake",0,fetcher);assert.equal(data[0].orderAbleQuantity,"9007199254740990.5");assert.equal(called,1);
  await assert.rejects(()=>fetchStockPage("fake","fake",0,(async()=>new Response('{"code":403,"msg":"signed request secret"}'))as typeof fetch),e=>e instanceof Error&&!e.message.includes("secret"));
});
test("机器人使用应用 token 和 sampleText JSON 字符串，测试不发真实消息",async()=>{
  const requests:string[]=[];
  const fetcher=(async(url,options)=>{requests.push(String(url)); const body=JSON.parse(String(options?.body));if(String(url).endsWith("/accessToken")){assert.equal(body.appKey,"fake-client");return Response.json({accessToken:"fake-token",expireIn:7200});}assert.equal(body.robotCode,"fake-robot");assert.equal(body.openConversationId,"fake-group");assert.equal(body.msgKey,"sampleText");assert.deepEqual(JSON.parse(body.msgParam),{content:"测试文本"});assert.equal((options?.headers as Record<string,string>)["x-acs-dingtalk-access-token"],"fake-token");return Response.json({processQueryKey:"fake-process"});}) as typeof fetch;
  assert.equal(await sendRobotMessage({clientId:"fake-client",clientSecret:"fake-secret",robotCode:"fake-robot",openConversationId:"fake-group"},"测试文本",fetcher),"fake-process");assert.equal(requests.length,2);
});
test("预警包含零库存与负库存，去重内容与顺序无关",()=>{
  const rows=[{goodsNo:"a",goodsName:"A",unitName:"Pcs",quantity:"-1",skuCount:1},{goodsNo:"b",goodsName:"B",unitName:"Pcs",quantity:"0",skuCount:1}];assert.equal(alertRows(rows,"0").length,2);assert.equal(alertDigest(rows,"0"),alertDigest([...rows].reverse(),"0"));
});
test("样本汇总严格为12个货品、1 Pcs，导出真实样本供独立校验",async()=>{
  const view=sampleView();assert.equal(view.goodsCount,12);assert.equal(view.totalsByUnit.Pcs,"1");assert.equal(view.zeroCount,11);assert.equal(view.snapshots.length,1);
  await fs.mkdir(".sites-runtime/test-output",{recursive:true});await fs.writeFile(".sites-runtime/test-output/sample-export.xlsx",inventoryWorkbook(view,view.rows));
});
