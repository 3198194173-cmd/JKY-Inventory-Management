import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { XingkongService, salesColumns } from '../lib/kingdee-xingkong';
import { XingkongCollections } from '../lib/kingdee-collections';
import { classifySalesRow, salesQuantity, type SalesRow } from '../lib/kingdee-sales-source';
import { createKingdeeImport, insertXingkongCollection, kingdeeView, xingkongCollectionDirectory } from '../lib/kingdee-store';
import { assessPreparation, preparationChoices } from '../lib/kingdee-preparation';
import { readKingdeeXlsx } from '../lib/kingdee-xlsx';
import { zipTextFiles } from '../lib/zip';
import type { SourceKind } from '../lib/kingdee-types';

const directory=mkdtempSync(resolve('.sites-runtime/tests/collections-'));
process.env.INVENTORY_DB_PATH=join(directory,'auth.sqlite');
process.env.KINGDEE_DB_PATH=join(directory,'kingdee.sqlite');
process.env.KINGDEE_STORAGE_DIR=join(directory,'files');
const binding={owner:'owner-a',actor:'actor-a'};
const credentials={accountId:'20200417192138569',username:'offline-user',password:'private-password'};
const settings={kind:'companySales',start:'2026-10-01',end:'2026-10-31',salesOrganization:'103',settleOrganization:'103'};
function business(code:string,quantity:string,customer='保留客户',name='商品'+code):SalesRow {
  return {...Object.fromEntries(salesColumns.map(([,field])=>[field,''])),FSALEORGNAME:'CASEBANG事业部',FSETTLEORGNAME:'CASEBANG事业部',FCUSTOMERNUMBER:'C-'+customer,FCUSTOMERNAME:customer,FMATERIALNUMBER:code,FMATERIALNAME:name,FMATERIALID:'123',FOUTSTOCKQTY:quantity,FUNITNAME:'Pcs',FCURRENCYNAME:'人民币',FISFREE:'是'};
}
function subtotal(row:SalesRow):SalesRow {
  return {...row,FMATERIALID:'123(小计)',FCUSTOMERNUMBER:'',FCUSTOMERNAME:'',FSETTLEORGNAME:'',FUNITNAME:'',FCURRENCYNAME:'',FISFREE:''};
}
const businessRows=[business('A','5'),business('A','-1'),business('B','7','casebang福田星河店'),business('C','0','保留客户','商品(小计)')];
const rawRows=businessRows.flatMap(row=>[row,subtotal(row)]);
const grand:SalesRow={...Object.fromEntries(salesColumns.map(([,field])=>[field,''])),FSALEORGNAME:'合计',FOUTSTOCKQTY:'11'};
type Query={StartRow:number;Limit:number;FieldKeys:string};
function fixture(reply?:(query:Query)=>{rows:SalesRow[];total:number}|Promise<{rows:SalesRow[];total:number}>) {
  const queries:Query[]=[];
  const service=new XingkongService((async (input,init)=>{
    const url=String(input),body=JSON.parse(String(init?.body));
    assert.equal(new URL(url).origin,'https://benks.ik3cloud.com');
    if(url.includes('ValidateUser'))return Response.json({LoginResultType:1},{headers:{'Set-Cookie':'ASP.NET_SessionId=private-cookie; Secure; HttpOnly'}});
    assert.match(new Headers(init?.headers).get('cookie')||'',/private-cookie/);
    if(url.includes('ExecuteBillQuery'))return new Response('[[3780019,"103","CASEBANG事业部"]]');
    assert.match(url,/GetSysReportData/);
    const query=JSON.parse(body.data) as Query;queries.push(query);
    const result=await reply?.(query)||{rows:[...rawRows,grand].slice(query.StartRow,query.StartRow+query.Limit),total:rawRows.length};
    return Response.json({Result:{IsSuccess:true,RowCount:result.total,Rows:result.rows.map(row=>salesColumns.map(([,field])=>row[field]))}});
  }) as typeof fetch);
  return {service,queries};
}
async function settle(manager:XingkongCollections,id:string) {
  for(let i=0;i<150;i++){const job=manager.get(binding.owner,id);if(!['running','cancelling'].includes(job.state))return job;await new Promise(accept=>setTimeout(accept,30));}
  throw new Error('Fixture job did not settle');
}
function xlsx(rows:Record<string,string>[]) {
  const escape=(v:string)=>v.replaceAll('&','&amp;').replaceAll('<','&lt;');
  return Buffer.from(zipTextFiles({
    'xl/workbook.xml':'<workbook><sheets><sheet name="Sheet1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':`<worksheet><sheetData>${rows.map((row,i)=>`<row r="${i+1}">${Object.entries(row).map(([col,value])=>`<c r="${col}${i+1}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`,
  }));
}
const others=[
  ['companyStock',[{},{},{},{A:'物料编码',B:'物料名称',C:'仓库名称',J:'结存'},{J:'数量'},{A:'A',B:'商品A',C:'CASEBANG电商仓',J:'2'},{A:'合计',J:'2'}]],
  ['storeSales',[{},{},{A:'商品编码',B:'商品名称',C:'基本数量'},{A:'A',B:'商品A',C:'1'},{A:'合计',C:'1'}]],
  ['storeStock',[{},{},{A:'商品编码',B:'商品名称',C:'即时库存（基本）'},{A:'A',B:'商品A',C:'3'},{A:'合计',C:'3'}]],
  ['prices',[{A:'物料编码',B:'价格',C:'编号',D:'币别',E:'含税',F:'价目对象',G:'整单状态',H:'销售组织'},{A:'A',B:'2.5',C:'P1',D:'人民币',E:'是',F:'按物料',G:'已审核',H:'CASEBANG事业部'}]],
] as [SourceKind,Record<string,string>[]][];
const uploads=()=>others.map(([kind,rows])=>({kind,name:kind+'.xlsx',bytes:xlsx(rows)}));

test('小计识别保留同名商品、赠品和负数，数量精确且拒绝异常格式',()=>{
  assert.equal(classifySalesRow(businessRows[3]),'business');assert.equal(classifySalesRow(subtotal(businessRows[3])),'subtotal');assert.equal(classifySalesRow(grand),'grandTotal');
  assert.equal(salesQuantity('-1,234.000000000000000001'),'-1234.000000000000000001');
  assert.equal(salesQuantity(null),'0');assert.throws(()=>salesQuantity('1,23'),/千分位/);assert.throws(()=>salesQuantity('not-number'));
});

test('完整分页、六客户排除、原始业务来源、统计和明细复用贯通，跨账户及损坏来源拒绝',async()=>{
  const mock=fixture(),manager=new XingkongCollections(mock.service,3),connection=await mock.service.connect(binding,credentials);
  const started=manager.start(binding,connection.token,settings);
  assert.throws(()=>manager.start(binding,connection.token,settings),/正在运行/);
  await assert.rejects(mock.service.probe(binding,connection.token,settings,{excludeCustomers:[]}),/会话已失效/);
  const job=await settle(manager,started.id);assert.equal(job.state,'ready',job.error);
  assert.deepEqual(mock.queries.map(q=>q.StartRow),[0,3,6]);assert.ok(mock.queries.every(q=>q.Limit===3));
  assert.deepEqual(job.progress,{pages:3,rawRows:9,reportedTotal:8,businessRows:4,subtotalRows:4,grandTotalRows:1,excludedCustomerRows:1,includedRows:3,businessQuantity:'11',includedQuantity:'4',blankQuantityRows:0});
  const source=await manager.download(binding.owner,job.id,'source'),rows=readKingdeeXlsx(source.bytes);
  assert.equal(rows.length,8);assert.equal(rows[3].cells.E,'A');assert.equal(rows[4].cells.Q,'-1');assert.equal(rows[5].cells.E,'B');assert.equal(rows.at(-1)!.cells.Q,'11');
  const stats=JSON.parse((await manager.download(binding.owner,job.id,'statistics')).bytes.toString());
  assert.deepEqual(stats.map((item:{code:string;quantity:string})=>[item.code,item.quantity]),[['A','4'],['C','0']]);
  assert.doesNotMatch(JSON.stringify(job)+source.bytes.toString()+(await manager.download(binding.owner,job.id,'audit')).bytes.toString(),/private-password|private-cookie|offline-user/);
  assert.throws(()=>manager.get('other',job.id),/找不到/);await assert.rejects(manager.download('other',job.id,'source'),/找不到/);
  const choices=preparationChoices(null);choices.companySales={mode:'api',batchId:'',collectionId:job.id};
  assert.equal(assessPreparation(choices,{},[],[job]).rows[0].ready,true);
  assert.equal(assessPreparation(choices,{},[],[{...job,state:'failed'}]).rows[0].ready,false);
  const batch=await createKingdeeImport(binding.owner,binding.actor,uploads(),undefined,{}, {companySales:job.id});
  assert.equal(batch.sources.find(s=>s.kind==='companySales')!.originCollectionId,job.id);
  assert.equal(batch.sources.find(s=>s.kind==='companySales')!.rows,4);
  assert.equal(kingdeeView(binding.owner).rows.find(r=>r.code==='A')!.companySales,'4');
  assert.equal(kingdeeView(binding.owner).rows.find(r=>r.code==='B')!.companySales,null);
  await assert.rejects(createKingdeeImport('other','other',uploads(),undefined,{}, {companySales:job.id}),/找不到/);
  await assert.rejects(createKingdeeImport(binding.owner,binding.actor,uploads(),undefined,{companySales:batch.id},{companySales:job.id}),/重复|同时|多种/);
  writeFileSync(join(xingkongCollectionDirectory(binding.owner,job.id),'source.xlsx'),'damaged');
  await assert.rejects(manager.download(binding.owner,job.id,'source'),/校验/);
  await assert.rejects(createKingdeeImport(binding.owner,binding.actor,uploads(),undefined,{}, {companySales:job.id}),/校验/);
  assert.equal(kingdeeView(binding.owner).batch!.id,batch.id);
  assert.doesNotMatch(readFileSync(process.env.KINGDEE_DB_PATH!).toString(),/private-cookie|private-password/);
});

test('变动总数、重复页、提前空页、非法业务行和非独立额外行均不发布完整来源',async()=>{
  const cases:[string,(q:Query)=>{rows:SalesRow[];total:number},RegExp][]=[
    ['changing',q=>({rows:rawRows.slice(q.StartRow,q.StartRow+3),total:q.StartRow===0?8:9}),/RowCount发生变化/],
    ['repeat',()=>({rows:rawRows.slice(0,3),total:8}),/重复页/],
    ['empty',q=>({rows:q.StartRow===0?rawRows.slice(0,3):[],total:8}),/空页/],
    ['missing',()=>({rows:[{...businessRows[0],FCUSTOMERNUMBER:''}],total:1}),/缺少物料或客户/],
    ['extra',()=>({rows:[businessRows[0],businessRows[1]],total:1}),/超过RowCount/],
  ];
  for(const [name,reply,error] of cases){
    const mock=fixture(reply),manager=new XingkongCollections(mock.service,3),connection=await mock.service.connect(binding,credentials);
    const job=await settle(manager,manager.start(binding,connection.token,settings).id);
    assert.equal(job.state,'failed',name);assert.match(job.error,error);assert.equal(job.source,undefined);
    await assert.rejects(manager.download(binding.owner,job.id,'source'),/尚无完整/);
  }
});

test('主动停止不发布部分结果；新进程将未完成任务标为中断，完成结果保持可读',async()=>{
  let release!:()=>void;const gate=new Promise<void>(accept=>release=accept);
  const mock=fixture(async()=>{await gate;return {rows:rawRows,total:8};});
  const manager=new XingkongCollections(mock.service,10),connection=await mock.service.connect(binding,credentials),started=manager.start(binding,connection.token,settings);
  manager.cancel(binding.owner,started.id);release();const job=await settle(manager,started.id);
  assert.equal(job.state,'cancelled');assert.equal(job.source,undefined);
  insertXingkongCollection(binding.owner,binding.actor,'obsolete-process',{...job,id:'ccf37bf1-1207-4b7e-95d4-ebd4c648eb77',state:'running'});
  const recovered=new XingkongCollections(mock.service,3);
  assert.equal(recovered.get(binding.owner,'ccf37bf1-1207-4b7e-95d4-ebd4c648eb77').state,'interrupted');
  assert.equal(recovered.get(binding.owner,job.id).state,'cancelled');
});
