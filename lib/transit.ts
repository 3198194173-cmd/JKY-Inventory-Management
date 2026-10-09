import { addQuantity, compareQuantity, divideQuantity, multiplyQuantityByInteger, normalizeQuantity, subtractQuantity } from './decimal';
import { GATEWAY, jackyunSign, shanghaiTimestamp } from './jackyun';
import { parseLosslessJson } from './lossless-json';
import type { InventoryMetrics } from './inventory-metrics';

export type TransitLine = { id:string; goodsNo:string; goodsName:string; skuId:string; unitName:string; applied:string; received:string; remaining:string };
export type TransitDocument = { id:string; no:string; state:string; audit:string; source:string; applyDate:string; modifiedAt:string; lines:TransitLine[]; error?:string; receipts?:{no:string; goodsNo:string; skuId:string; unitName:string; quantity:string; time:string}[]; receiptStatus?:string };
export type TransitGoods = { goodsNo:string; goodsName:string; unitName:string; quantity:string };
export type TransitResult = { startedAt:string; completedAt:string; from:string; documents:TransitDocument[]; goods:TransitGoods[]; issues:string[]; requests:number };
export type TransitMetric = { quantity:string|null; replenishment:string|null; coverageDays:string|null; reason:string|null };
const text=(value:unknown)=>value==null?'':String(value);
const closed=(d:TransitDocument)=>d.audit==='3';
export const isOutstanding=(d:TransitDocument)=>!closed(d)&&['1','2'].includes(d.state);

export function transitMetric(quantity:string|null, stock:string, metrics?:InventoryMetrics):TransitMetric {
  if(quantity==null)return {quantity:null,replenishment:null,coverageDays:null,reason:'在途尚未核验'};
  if(!metrics?.total7||metrics.validDays!==7||compareQuantity(metrics.total7,'0')<=0)return {quantity,replenishment:null,coverageDays:null,reason:'缺少有效的7天销售均值'};
  const available=addQuantity(stock,quantity);
  // Use the exact seven-day total, not the rounded displayed average.
  const deficit=subtractQuantity(multiplyQuantityByInteger(metrics.total7,30),multiplyQuantityByInteger(available,7));
  return {quantity,replenishment:compareQuantity(deficit,'0')>0?divideQuantity(deficit,'7',2):'0',coverageDays:divideQuantity(multiplyQuantityByInteger(available,7),metrics.total7),reason:null};
}

export async function collectTransit(appkey:string,secret:string,warehouseCode:string,previous:TransitDocument[]=[],fetcher:typeof fetch=fetch,onProgress:(requests:number)=>Promise<void>=async()=>{},from='2020-01-01 00:00:00'):Promise<TransitResult> {
  const startedAt=new Date().toISOString(),until=shanghaiTimestamp(new Date(startedAt));
  const result:TransitResult={startedAt,completedAt:'',from,documents:[],goods:[],issues:[],requests:0};
  type Row=Record<string,unknown>;
  async function pages(method:string,args:Row,key:string):Promise<Row[]> {
    const collected:Row[]=[],identities=new Set<string>();
    for(let pageIndex=0;pageIndex<2000;pageIndex++){
      let response:Response|undefined;
      const bizcontent=JSON.stringify({warehouseCode,pageSize:50,...args,pageIndex});
      for(let attempt=0;attempt<3;attempt++){
        const params={appkey,bizcontent,contenttype:'json',method,timestamp:shanghaiTimestamp(),version:'v1.0'};
        try{response=await fetcher(GATEWAY,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body:new URLSearchParams({...params,sign:jackyunSign(params,secret)}),signal:AbortSignal.timeout(25000)});}catch{response=undefined;}
        result.requests++;await onProgress(result.requests);
        if(response&&response.status!==429&&response.status<500)break;
        if(attempt<2)await new Promise(r=>setTimeout(r,500*(attempt+1)));
      }
      if(!response?.ok)throw new Error('在途接口网络失败，未采用部分结果');
      let body:{code:unknown;subCode:unknown;result?:{data?:unknown;noPrivilegeItem?:unknown}};
      try{body=parseLosslessJson(await response.text()) as typeof body;}catch{throw new Error('在途接口响应格式无效');}
      const privilege=body.result?.noPrivilegeItem;
      if(String(body.code)!=='200')throw new Error(`在途接口业务失败（${text(body.subCode).replace(/[^\w-]/g,'').slice(0,30)}）`);
      if(privilege!=null&&!['','[]','{}'].includes(typeof privilege==='object'?JSON.stringify(privilege):String(privilege)))throw new Error('在途接口存在权限受限字段');
      const rows=body.result?.data;
      if(!Array.isArray(rows)||rows.length>50)throw new Error('在途接口分页数组无效');
      if(!rows.length)return collected;
      for(const row of rows){
        if(!row||typeof row!=='object'||Array.isArray(row)||!text(row[key]))throw new Error('在途记录缺少身份');
        if(text(row.inWarehouseCode??row.warehouseCode)!==warehouseCode)throw new Error('在途记录仓库不一致');
        const id=text(row[key]);if(identities.has(id))throw new Error('在途分页记录重复，停止以免漏算');
        identities.add(id);collected.push(row);
      }
    }
    throw new Error('在途分页超过保护上限');
  }
  const range={applyDateFrom:from,applyDateTo:until,isNotification:0,isListLogistic:0};
  const parents=new Map<string,Row>();
  for(const state of ['1','2'])for(const row of await pages('erp.stockin.get',{...range,inStatus:state},'inId')){
    if(text(row.inStatus)!==state)throw new Error('入库状态筛选未生效');
    if(parents.has(text(row.inId)))throw new Error('采集时申请单状态发生变化，请重试');
    parents.set(text(row.inId),row);
  }
  // A missing waiting item may be complete/closed or inaccessible. Recheck its
  // identity without a status filter; disappearance alone never means zero.
  for(const prior of previous.filter(d=>isOutstanding(d)||d.error||d.receiptStatus?.includes("待核验")))if(!parents.has(prior.id)){
    const rows=await pages('erp.stockin.get',{...range,inNo:prior.no},'inId');
    const exact=rows.find(r=>text(r.inId)===prior.id&&text(r.inNo)===prior.no);
    if(rows.some(r=>text(r.inNo)!==prior.no))throw new Error('申请单号筛选未生效');
    if(exact)parents.set(prior.id,exact);
    else {const message=`${prior.no} 未查到，不能确认完成`;result.documents.push({...prior,error:message});result.issues.push(message);}
  }
  const cols='inId,inNo,inDetailId,inWarehouseCode,inStatus,status,goodsNo,goodsName,skuId,unitName,skuCount,innerCount,uninnerCount,applyDate,gmtModified,relDataId';
  for(const parent of parents.values()){
    const doc:TransitDocument={id:text(parent.inId),no:text(parent.inNo),state:text(parent.inStatus),audit:text(parent.status),source:text(parent.relDataId),applyDate:text(parent.applyDate),modifiedAt:text(parent.gmtModified),lines:[]};
    result.documents.push(doc);
    try{
      if(!doc.no||!['0','1','2','3','10'].includes(doc.audit)||!['1','2','3'].includes(doc.state))throw new Error('未知入库状态');
      const rows=await pages('erp.stockin.get.v2',{...range,inNo:doc.no,cols},'inDetailId');
      if(!rows.length)throw new Error('申请明细为空，无法核验');
      for(const row of rows){
        if(text(row.inNo)!==doc.no||text(row.inId)!==doc.id||text(row.inStatus)!==doc.state||text(row.status)!==doc.audit)throw new Error('主表与明细身份或状态不同步');
        const line:TransitLine={id:text(row.inDetailId),goodsNo:text(row.goodsNo),goodsName:text(row.goodsName),skuId:text(row.skuId),unitName:text(row.unitName),applied:normalizeQuantity(row.skuCount),received:normalizeQuantity(row.innerCount),remaining:normalizeQuantity(row.uninnerCount)};
        if(!line.goodsNo||!line.skuId||!line.unitName)throw new Error('明细缺少商品、规格或单位');
        if([line.applied,line.received,line.remaining].some(q=>compareQuantity(q,'0')<0)||compareQuantity(line.applied,addQuantity(line.received,line.remaining))!==0)throw new Error('申请、已入库与剩余数量不一致');
        if(doc.state==='1'&&line.received!=='0'||doc.state==='3'&&line.remaining!=='0')throw new Error('入库状态与剩余数量不一致');
        doc.lines.push(line);
      }
      for(const [header,field] of [['skuCount','applied'],['innerCount','received'],['uninnerCount','remaining']] as const){
        if(compareQuantity(normalizeQuantity(parent[header]),doc.lines.reduce((sum,r)=>addQuantity(sum,r[field]),'0'))!==0)throw new Error('整单与明细数量不一致');
      }
    }catch(error){doc.error=`${doc.no}：${error instanceof Error?error.message:'明细核验失败'}`;result.issues.push(doc.error);}
    // Receipts explain the lifecycle; they never add to live stock a second time.
    if(!doc.error&&!closed(doc)&&['2','3'].includes(doc.state)){
      try{
        const receipts:Row[]=[];
        for(const archived of [0,1])receipts.push(...await pages('erp-busiorder.goodsdocin.search',{billNo:doc.no,archived,inOutDateStart:from,inOutDateEnd:until,cols:'recId,goodsdocNo,billNo,goodsNo,skuId,unitName,quantity,inOutDate,warehouseCode'},'recId'));
        const seen=new Set<string>();const totals=new Map<string,string>();doc.receipts=[];
        for(const row of receipts){if(text(row.billNo)!==doc.no||seen.has(text(row.recId)))throw new Error('实际入库关联或明细重复');seen.add(text(row.recId));
          const key=JSON.stringify([text(row.goodsNo),text(row.skuId),text(row.unitName)]),quantity=normalizeQuantity(row.quantity);totals.set(key,addQuantity(totals.get(key)||'0',quantity));
          doc.receipts.push({no:text(row.goodsdocNo),goodsNo:text(row.goodsNo),skuId:text(row.skuId),unitName:text(row.unitName),quantity,time:text(row.inOutDate)});
        }
        const expected=new Map<string,string>();for(const line of doc.lines){const key=JSON.stringify([line.goodsNo,line.skuId,line.unitName]);expected.set(key,addQuantity(expected.get(key)||'0',line.received));}
        doc.receiptStatus=[...new Set([...totals.keys(),...expected.keys()])].every(k=>compareQuantity(totals.get(k)||'0',expected.get(k)||'0')===0)?'实际入库已对账':'实际入库数量待核验';
      }catch{doc.receiptStatus='实际入库关联待核验';}
    }
  }
  const goods=new Map<string,TransitGoods>();
  for(const doc of result.documents.filter(d=>isOutstanding(d)&&!d.error))for(const line of doc.lines){
    const existing=goods.get(line.goodsNo);
    if(existing&&existing.unitName!==line.unitName){result.issues.push(`${line.goodsNo} 在途单位不一致`);continue;}
    goods.set(line.goodsNo,{goodsNo:line.goodsNo,goodsName:line.goodsName,unitName:line.unitName,quantity:addQuantity(existing?.quantity||'0',line.remaining)});
  }
  result.goods=[...goods.values()];result.completedAt=new Date().toISOString();return result;
}
