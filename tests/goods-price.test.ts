import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { purchaseFlag, fetchGoodsPage, flatSourceWorkbook } from '../lib/kingdee-goods-source';
import { mapPriceRows, priceRequest, priceSourceWorkbook, readPriceSchema, priceKeys, type PriceSchema } from '../lib/kingdee-price-source';
import { importKingdeeFiles } from '../lib/kingdee-import';
import { sheetColumns,sheetValue,defaultKingdeeTemplate,sheetDataPath } from '../lib/kingdee-sheet';
import { readKingdeeXlsx } from '../lib/kingdee-xlsx';
import { kingdeeWorkbook } from '../lib/kingdee-export';
import { fixture,xlsx } from './kingdee-fixtures';
import preset from '../data/kingdee-default-rules.json';
import type { KingdeeRules,SourceKind } from '../lib/kingdee-types';
import { XingkongCollections } from '../lib/kingdee-collections';
import { XingkongService } from '../lib/kingdee-xingkong';

const root=mkdtempSync(resolve('.sites-runtime/tests/goods-price-'));
process.env.INVENTORY_DB_PATH=join(root,'auth.sqlite');process.env.KINGDEE_DB_PATH=join(root,'kingdee.sqlite');process.env.KINGDEE_STORAGE_DIR=join(root,'files');
const schema:PriceSchema={fields:Object.fromEntries(priceKeys.map(key=>[key,'F'+key])) as PriceSchema['fields'],values:{taxIncluded:'true',byMaterial:'1',approved:'C',disabledNo:'false'}};
const raw={Fid:'9007199254740993',FentryId:'9007199254740995',Fnumber:'XSJMB1110',ForganizationCode:'103',ForganizationName:'CASEBANG事业部',FmaterialCode:'A',FmaterialName:'甲',Fprice:'2.5000',Fcurrency:'人民币',FtaxIncluded:'true',FpriceObject:'1',FdocumentStatus:'C',Fdisabled:'false',Funit:'Pcs',FeffectiveDate:'2026-10-01',FexpiryDate:'2026-12-31'};
const runSettings={start:'2026-10-01',end:'2026-10-31',salesOrganization:'103',settleOrganization:'103',schemeId:'abcdef',priceListNumber:'XSJMB1110'};
async function finish(manager:XingkongCollections,owner:string){for(let n=0;n<150&&manager.runs(owner)[0].state==='running';n++)await new Promise(resolve=>setTimeout(resolve,20));return manager.runs(owner)[0];}
test('停止采购严格识别真假，空值和未知不变成否',()=>{for(const value of [true,1,'1','true'])assert.equal(purchaseFlag(value),'是');for(const value of [false,0,'0','false'])assert.equal(purchaseFlag(value),'否');for(const value of [null,undefined,'',2,'no',{},'是'])assert.equal(purchaseFlag(value),null);});
test('货品查询固定只读方法、游标与页大小；权限异常不发布',async()=>{
  const controller=new AbortController();
  const page=await fetchGoodsPage('test-key','test-secret','0',controller.signal,(async(url,init)=>{assert.equal(String(url),'https://open.jackyun.com/open/openapi/do');const params=new URLSearchParams(String(init?.body));assert.equal(params.get('method'),'erp.storage.goodslist');assert.deepEqual(JSON.parse(params.get('bizcontent')!),{pageIndex:0,pageSize:200,maxSkuId:'0'});return new Response('{"code":200,"result":{"data":{"goods":[{"goodsNo":"A","goodsName":"甲","skuId":9007199254740995,"isStopPurchasing":0}]},"pageInfo":{"total":1}}}');}) as typeof fetch);
  assert.equal(page.rows[0].skuId,'9007199254740995');assert.equal(page.rows[0].stopPurchasing,'否');assert.equal(page.total,1);
  await assert.rejects(fetchGoodsPage('k','s','0',controller.signal,(async()=>Response.json({code:200,result:{data:{goods:[]},noPrivilegeItem:['isStopPurchasing']}})) as typeof fetch),/权限/);
});
test('停止采购统一覆盖所有视图C列；未命中、冲突不填否且货品全目录不扩大明细',async()=>{
  const files=Object.entries(fixture).map(([kind,bytes])=>{const path=join(root,kind+'.xlsx');writeFileSync(path,bytes);return {kind:kind as SourceKind,path,name:kind+'.xlsx'};});
  const legacy=join(root,'legacy.xlsx');writeFileSync(legacy,xlsx([Object.fromEntries(defaultKingdeeTemplate.columns.map(c=>[c.key,c.label])),{A:'类目',B:'型号',C:'POD',D:'IP',E:'A',F:'甲'},{C:'POD',E:'B',F:'乙'},{C:'POD',E:'C',F:'丙'}],'明细'));
  const goods=join(root,'goods.xlsx');writeFileSync(goods,flatSourceWorkbook(['物料编码','物料名称','停止采购','规格内码'],[['A','甲','否','1'],['B','乙','是','2'],['B','乙','否','3'],['UNUSED','不属于业务目录','是','4']],'货品'));
  const report=await importKingdeeFiles([...files,{kind:'legacy',path:legacy,name:'old.xlsx'},{kind:'goods',path:goods,name:'goods.xlsx'}],preset as KingdeeRules);
  assert.equal(report.rows.length,3);const [a,b,c]=report.rows;assert.equal(a.stopPurchasing,'否');assert.equal(sheetValue(a,2,'current'),'否');assert.equal(sheetValue(a,2,'original'),'否');assert.equal(b.purchaseStatus,'conflict');assert.equal(b.stopPurchasing,null);assert.equal(c.purchaseStatus,'missing');
  assert.equal(sheetColumns(defaultKingdeeTemplate,'current')[2].label,'停止采购');assert.equal(sheetDataPath(2,'current'),'$.stopPurchasing');
  for (const periods of [[], undefined]) for (const mode of ['current','original'] as const) {
    const template={...defaultKingdeeTemplate,periods,purchaseColumn:false};
    assert.equal(sheetColumns(template,mode)[2].label,'停止采购');
    assert.equal(sheetDataPath(2,mode,template),'$.stopPurchasing');
    assert.equal(sheetValue(a,2,mode,template),'否');
    assert.equal(sheetValue({...a,stopPurchasing:'是'},2,mode,template),'是');
    assert.equal(sheetValue(b,2,mode,template),null);
    assert.equal(sheetValue(c,2,mode,template),null);
    const exported=readKingdeeXlsx(Buffer.from(kingdeeWorkbook({...report,template,id:'test',createdAt:'2026-10-23',state:'ready',error:''},report.rows,mode)));
    assert.equal(exported[0].cells.C,'停止采购');
    assert.equal(exported[1].cells.C,'否');
    assert.ok(!exported[2].cells.C);assert.ok(!exported[3].cells.C);
  }
});
test('价目表只使用明确字段配置，组织编号逐行校验，全部状态保留；不改写原价格精度',()=>{
  assert.throws(()=>readPriceSchema(''),/尚未核验/);assert.throws(()=>readPriceSchema('{}'),/不完整/);
  const request=priceRequest(schema,'103',"P'1",0,10000);assert.equal(request.FormId,'BD_SAL_PriceList');assert.equal(request.Limit,2000);assert.equal(request.FilterString[1].Value,"P'1");assert.equal(request.FilterString.length,2);
  const rows=mapPriceRows([raw],schema,'103','XSJMB1110');assert.equal(rows[0].price,'2.5000');
  assert.throws(()=>mapPriceRows([{...raw,ForganizationCode:'104'}],schema,'103','XSJMB1110'),/组织/);
  assert.equal(mapPriceRows([{...raw,Fdisabled:'true'}],schema,'103','XSJMB1110')[0].disabled,'true');
  assert.throws(()=>mapPriceRows([{FNumber:'XSJMB1110'}],schema,'103','XSJMB1110'),/缺少/);
  const out=readKingdeeXlsx(priceSourceWorkbook(rows,schema));assert.equal(out[1].cells.C,'2.5000');assert.equal(out[1].cells.F,'是');assert.equal(out[1].cells.K,'Pcs');
});
test('统一后台任务一次登录依次执行，读取空尾页才完成，子任务独立留存，跨账户不可停止',async()=>{
  process.env.KINGDEE_PRICE_SCHEMA=JSON.stringify(schema);process.env.JACKYUN_APP_KEY='fixture';process.env.JACKYUN_APP_SECRET='fixture';
  const calls:string[]=[];
  const service=new XingkongService((async(url,init)=>{calls.push(String(url));const body=JSON.parse(String(init?.body));
    if(String(url).includes('ValidateUser'))return Response.json({LoginResultType:1},{headers:{'Set-Cookie':'session=private; HttpOnly'}});
    if(String(url).includes('ExecuteBillQuery'))return Response.json([[3780019,'103','CASEBANG事业部']]);
    assert.match(String(url),/\.BillQuery\./);const query=JSON.parse(body.data);return Response.json(query.StartRow===0?[raw]:[]);
  }) as typeof fetch);
  const manager=new XingkongCollections(service,2000,async(_key,_secret,cursor)=>({rows:cursor==='0'?[{goodsNo:'A',goodsName:'甲',skuId:'9007199254740995',stopPurchasing:'否'}]:[],total:cursor==='0'?1:0}));
  const binding={owner:'owner',actor:'actor'},connection=await service.connect(binding,{accountId:'20200417192138569',username:'user',password:'secret'});
  const run=manager.startRun(binding,connection.token,{kinds:['prices','goods'],start:'2026-10-01',end:'2026-10-31',salesOrganization:'103',settleOrganization:'103',schemeId:'abcdef',priceListNumber:'XSJMB1110'});
  assert.throws(()=>manager.cancelRun('another',run.id),/没有/);
  for(let n=0;n<150&&manager.runs('owner')[0].state==='running';n++)await new Promise(resolve=>setTimeout(resolve,20));
  const done=manager.runs('owner')[0];assert.equal(done.state,'ready',done.error);assert.equal(calls.filter(url=>url.includes('ValidateUser')).length,1);assert.equal(calls.filter(url=>url.includes('.BillQuery.')).length,2);
  assert.equal(manager.list('owner','prices').length,1);assert.equal(manager.list('owner','goods').length,1);assert.equal(manager.list('another').length,0);
  await assert.rejects(service.probe(binding,connection.token,{kind:'prices',start:'2026-10-01',end:'2026-10-31',salesOrganization:'103'},{excludeCustomers:[]}),/失效/);
  delete process.env.KINGDEE_PRICE_SCHEMA;delete process.env.JACKYUN_APP_KEY;delete process.env.JACKYUN_APP_SECRET;
});

test('价目表重复分录不发布，后续货品任务继续，部分失败不能伪装全部成功',async()=>{
  process.env.KINGDEE_PRICE_SCHEMA=JSON.stringify(schema);process.env.JACKYUN_APP_KEY='fixture';process.env.JACKYUN_APP_SECRET='fixture';
  try{
    const service=new XingkongService((async(url)=>{
      if(String(url).includes('ValidateUser'))return Response.json({LoginResultType:1},{headers:{'Set-Cookie':'session=private'}});
      if(String(url).includes('ExecuteBillQuery'))return Response.json([[3780019,'103','CASEBANG事业部']]);
      return Response.json([raw,raw]);
    }) as typeof fetch);
    const manager=new XingkongCollections(service,2000,async()=>({rows:[],total:0})),binding={owner:'partial',actor:'actor'};
    const connection=await service.connect(binding,{accountId:'20200417192138569',username:'user',password:'secret'});
    manager.startRun(binding,connection.token,{...runSettings,kinds:['prices','goods']});const done=await finish(manager,binding.owner);
    assert.equal(done.state,'failed');assert.match(done.error,/重复分录/);assert.equal(manager.list(binding.owner,'prices')[0].source,undefined);assert.equal(manager.list(binding.owner,'goods')[0].state,'ready');
  }finally{delete process.env.KINGDEE_PRICE_SCHEMA;delete process.env.JACKYUN_APP_KEY;delete process.env.JACKYUN_APP_SECRET;}
});

test('停止统一任务会中断正在请求的复用会话，不启动后续模块，也不发布部分价格',async()=>{
  process.env.KINGDEE_PRICE_SCHEMA=JSON.stringify(schema);
  try{
    let priceStarted=false;
    const service=new XingkongService((async(url,init)=>{
      if(String(url).includes('ValidateUser'))return Response.json({LoginResultType:1},{headers:{'Set-Cookie':'session=private'}});
      if(String(url).includes('ExecuteBillQuery'))return Response.json([[3780019,'103','CASEBANG事业部']]);
      priceStarted=true;return await new Promise<Response>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
    }) as typeof fetch);
    const manager=new XingkongCollections(service),binding={owner:'cancelled-run',actor:'actor'},connection=await service.connect(binding,{accountId:'20200417192138569',username:'user',password:'secret'});
    const run=manager.startRun(binding,connection.token,{...runSettings,kinds:['prices','goods']});
    for(let n=0;n<100&&!priceStarted;n++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(priceStarted,true);
    manager.cancelRun(binding.owner,run.id);const done=await finish(manager,binding.owner);assert.equal(done.state,'cancelled');assert.equal(manager.list(binding.owner,'prices')[0].state,'cancelled');assert.equal(manager.list(binding.owner,'prices')[0].source,undefined);assert.equal(manager.list(binding.owner,'goods').length,0);
  }finally{delete process.env.KINGDEE_PRICE_SCHEMA;}
});

test('货品游标重复和首批总数不一致均拒绝发布来源',async()=>{
  process.env.JACKYUN_APP_KEY='fixture';process.env.JACKYUN_APP_SECRET='fixture';
  try{
    for(const mode of ['duplicate','count']){
      const manager=new XingkongCollections(new XingkongService(),2000,async(_key,_secret,cursor)=>({rows:cursor==='0'||mode==='duplicate'?[{goodsNo:'A',goodsName:'甲',skuId:'1',stopPurchasing:'否'}]:[],total:2}));
      manager.startRun({owner:mode,actor:'actor'},'',{kinds:['goods']});const done=await finish(manager,mode);
      assert.equal(done.state,'failed');assert.equal(manager.list(mode,'goods')[0].source,undefined);assert.match(done.error,mode==='duplicate'?/游标/:/总数/);
    }
  }finally{delete process.env.JACKYUN_APP_KEY;delete process.env.JACKYUN_APP_SECRET;}
});
