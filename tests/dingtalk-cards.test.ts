import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import { turnoverCards, cardTemplateId, normalizeCardTemplateId } from "../lib/dingtalk-card-data";
import { turnoverCardSvg, renderTurnoverCard } from "../lib/dingtalk-card-image";
import { DingTalkCardError, sendRobotCard, sendInventoryReport } from "../lib/dingtalk-cards";
import type { InventoryView } from "../lib/inventory-types";

const rows = (count: number): InventoryView["rows"] => Array.from({length:count},(_,i)=>({goodsNo:`C.Q.CB.AP.00.${String(i+1).padStart(4,'0')}`,goodsName:'卡片预览示例',unitName:'Pcs',skuCount:1,quantity:String(40+i),history:{},sales:Object.fromEntries([3,6,11,-2,15,36,1].map((q,j)=>[`2026-10-0${j+1}`,String(q)])),metrics:{total7:'70',average7:'10',turnoverDays:'4',validDays:7,basis:'inbound_adjusted_difference',reason:null}}));
const card=turnoverCards(rows(5),'3','测试仓（CK031）','2026-10-08T00:00:23Z')[0];
const templateId='957e3c25-a2d9-4cd3-a424-be40f18a9f9b';
const apiTemplateId=templateId+'.schema';
const credentials={clientId:'card-test',clientSecret:'isolated-card-secret',robotCode:'card-robot',openConversationId:'card-group'};

test('完整报表每张12款，不丢失货品、负销量、精确数量或日期',()=>{
  const cards=turnoverCards(rows(1203),'3','全仓','2026-10-07T16:00:23Z');
  assert.equal(cards.length,101);assert.equal(cards.flatMap(c=>c.rows).length,1203);assert.equal(cards.at(-1)!.rows.length,3);
  assert.deepEqual(cards[0].dates,['2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07']);
  assert.equal(cards[0].rows[0].sales[3],'-2');assert.equal(cards[100].part,101);assert.equal(cards[100].totalParts,101);
  const exact=rows(1);exact[0].quantity='9007199254740993.125';delete exact[0].sales!['2026-10-03'];
  const result=turnoverCards(exact,'3','仓','2026-10-08T00:00:23Z')[0];
  assert.equal(result.rows[0].quantity,exact[0].quantity);assert.equal(result.rows[0].sales[2],null);
});
test('横向表格真实渲染ECharts平滑曲线和PNG；编码进行XML转义',async()=>{
  const escaped=structuredClone(card);escaped.rows[0].goodsNo='<script>&"';
  const svg=turnoverCardSvg(escaped);assert.match(svg,/&lt;script&gt;&amp;&quot;/);assert.doesNotMatch(svg,/<script|NaN|Infinity/);assert.match(svg,/d="M[^"]*C/);
  const png=await renderTurnoverCard(card),metadata=await sharp(png).metadata();assert.equal(metadata.format,'png');assert.equal(metadata.width,1200);assert.equal(metadata.height,578);
  await mkdir('outputs',{recursive:true});await writeFile('outputs/dingtalk-inventory-card.png',png);
});
test('图片上传后投放指定群的卡片；验证真正投放结果，无自动重试或文字降级',async()=>{
  const calls:string[]=[],png=await renderTurnoverCard(card);
  const fetcher=(async(url: unknown,options: RequestInit)=>{
    calls.push(String(url));
    if(String(url).includes('/oauth2/'))return Response.json({accessToken:'mock-card-token',expireIn:7200});
    if(String(url).includes('/media/upload')){assert.ok(options.body instanceof FormData);assert.equal((options.body as FormData).get('media') instanceof Blob,true);return Response.json({errcode:0,media_id:'$mock-image'});}
    const body=JSON.parse(options.body as string);assert.equal(body.cardTemplateId,apiTemplateId);assert.equal(body.openSpaceId,'dtv1.card//IM_GROUP.card-group');assert.equal(body.imGroupOpenDeliverModel.robotCode,'card-robot');assert.equal(body.cardData.cardParamMap.reportImage,'$mock-image');assert.equal(JSON.parse(body.cardData.cardParamMap.config).autoLayout,true);
    return Response.json({success:true,result:{outTrackId:body.outTrackId,deliverResults:[{success:true,spaceId:'card-group',spaceType:'IM_GROUP'}]}});
  }) as typeof fetch;
  assert.ok(await sendRobotCard(credentials,card,png,templateId,fetcher));assert.equal(calls.length,3);
  let attempts=0;
  const failed=(async(url:unknown)=>{attempts++;return String(url).includes('/media/upload')?Response.json({errcode:0,media_id:'$mock-image'}):Response.json({success:true,result:{deliverResults:[{success:false,spaceId:'card-group',spaceType:'IM_GROUP'}]}});}) as typeof fetch;
  await assert.rejects(()=>sendRobotCard(credentials,card,png,templateId,failed),/未确认/);assert.equal(attempts,2);
  await assert.rejects(()=>sendRobotCard(credentials,card,png,templateId,(async()=>new Response('',{status:403})) as typeof fetch),/图片上传失败/);
});
test('配置模板后走卡片传输并记录受理张数；未配置继续文字通知',async()=>{
  const previous=process.env.DINGTALK_CARD_TEMPLATE_ID,fetcher=globalThis.fetch;
  try {
    process.env.DINGTALK_CARD_TEMPLATE_ID=templateId;assert.equal(cardTemplateId(),apiTemplateId);
    let uploads=0,deliveries=0,accepted=0;
    globalThis.fetch=(async(url:unknown,options:RequestInit)=>{
      if(String(url).includes('/media/upload')){uploads++;return Response.json({errcode:0,media_id:'$mock-image'});}
      if(String(url).includes('/createAndDeliver')){deliveries++;const body=JSON.parse(options.body as string);assert.equal(body.cardTemplateId,apiTemplateId);return Response.json({success:true,result:{outTrackId:body.outTrackId,deliverResults:[{success:true,spaceId:credentials.openConversationId,spaceType:'IM_GROUP'}]}});}
      throw Error('禁止外部请求');
    }) as typeof fetch;
    await sendInventoryReport(credentials,{messages:['mock text'],cards:[card]},undefined,parts=>accepted=parts);
    assert.equal(uploads,1);assert.equal(deliveries,1);assert.equal(accepted,1);
    delete process.env.DINGTALK_CARD_TEMPLATE_ID;
    let texts=0;await sendInventoryReport(credentials,{messages:['完整文字'],cards:[card]},async(_c,m)=>{assert.equal(m,'完整文字');texts++;return 'mock';});assert.equal(texts,1);
    process.env.DINGTALK_CARD_TEMPLATE_ID='invalid';assert.throws(cardTemplateId,/格式无效/);
  } finally {globalThis.fetch=fetcher;if(previous===undefined)delete process.env.DINGTALK_CARD_TEMPLATE_ID;else process.env.DINGTALK_CARD_TEMPLATE_ID=previous;}
});

test('模板UUID转换为接口schema ID，完整ID不重复追加，非法ID在任何请求前拒绝',async()=>{
  assert.equal(normalizeCardTemplateId(' '+templateId+' '),apiTemplateId);
  assert.equal(normalizeCardTemplateId(apiTemplateId),apiTemplateId);
  assert.equal(normalizeCardTemplateId(templateId+'.SCHEMA'),apiTemplateId);
  assert.equal(normalizeCardTemplateId(''), '');
  for(const invalid of [templateId+'.schema.schema','not-a-template',templateId+'?x=1'])assert.throws(()=>normalizeCardTemplateId(invalid),/格式无效/);
  let calls=0;const fetcher=(async()=>{calls++;throw Error('禁止调用');}) as typeof fetch;
  await assert.rejects(()=>sendRobotCard(credentials,card,new Uint8Array(),'',fetcher),/不能为空/);
  await assert.rejects(()=>sendRobotCard(credentials,card,new Uint8Array(),'invalid',fetcher),/格式无效/);
  assert.equal(calls,0);
});

test('卡片400显示具体错误码、模板提示和请求编号；403与超时分类且不泄露响应凭证',async()=>{
  const png=new Uint8Array([1,2,3]);
  const reject=async(status:number,body:unknown)=>{
    let calls=0;
    const fetcher=(async(url:unknown)=>{
      calls++;
      if(String(url).includes('/media/upload'))return Response.json({errcode:0,media_id:'private-image'});
      return typeof body==='string' ? new Response(body,{status}) : Response.json(body,{status});
    }) as typeof fetch;
    let captured:unknown;
    try {await sendRobotCard(credentials,card,png,templateId,fetcher);}catch(error){captured=error;}
    assert.equal(calls,2,'失败不自动重试');assert.ok(captured instanceof DingTalkCardError);
    return captured;
  };
  const invalid=await reject(400,{code:'param.cardTemplateIdInvalid',message:'private-image isolated-card-secret mock-card-token',requestid:'trace-400'});
  assert.equal(invalid.rejected,true);assert.match(invalid.message,/param.cardTemplateIdInvalid/);assert.match(invalid.message,/\.schema/);assert.match(invalid.message,/trace-400/);
  assert.doesNotMatch(invalid.message,/private-image|isolated-card-secret|mock-card-token/);
  const missing=await reject(400,{code:'param.templateNotExist',requestid:'trace-missing'});
  assert.equal(missing.rejected,true);assert.ok(missing.message.includes(apiTemplateId));assert.match(missing.message,/自己的已保存模板/);
  const denied=await reject(403,{code:'Forbidden.AccessDenied',message:'permission denied'});
  assert.equal(denied.rejected,true);assert.match(denied.message,/互动卡片实例写权限/);
  const secret=await reject(400,{code:'isolated-card-secret',requestId:'mock-card-token',message:'https://example.com/?access_token=mock-card-token'});
  assert.doesNotMatch(secret.message,/isolated-card-secret|mock-card-token|https:/);
  const html=await reject(400,'<html>private-image</html>');assert.match(html.message,/请求参数/);assert.doesNotMatch(html.message,/html|private-image/);
  assert.equal((await reject(408,{code:'RequestTimeout'})).rejected,false,'服务端超时仍按未确认处理');
  assert.equal((await reject(500,{code:'InternalError'})).rejected,false,'服务端异常不误报确定失败');
});
