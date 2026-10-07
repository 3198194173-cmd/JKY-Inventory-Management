import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { turnoverCards, cardTemplateId, normalizeCardTemplateId, nativeCardParams } from "../lib/dingtalk-card-data";
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
test('投放原生数据卡片，不生成或上传图片；验证指定群真正投放结果，无自动重试',async()=>{
  const calls:string[]=[];
  const fetcher=(async(url: unknown,options: RequestInit)=>{
    calls.push(String(url));
    if(String(url).includes('/oauth2/'))return Response.json({accessToken:'mock-card-token',expireIn:7200});
    assert.ok(String(url).includes('/createAndDeliver'));
    const body=JSON.parse(options.body as string);assert.equal(body.cardTemplateId,apiTemplateId);assert.equal(body.openSpaceId,'dtv1.card//IM_GROUP.card-group');assert.equal(body.imGroupOpenDeliverModel.robotCode,'card-robot');assert.equal(body.cardData.cardParamMap.reportImage,undefined);assert.equal(JSON.parse(body.cardData.cardParamMap.config).autoLayout,true);
    const dataRows=JSON.parse(body.cardData.cardParamMap.rows);assert.equal(dataRows.length,5);assert.equal(dataRows[0].chart.type,'lineChart');assert.equal(dataRows[0].chart.data[3].y,-2);assert.equal(dataRows[0].quantity,'40');assert.equal(dataRows[0].salesDetail,undefined);
    return Response.json({success:true,result:{outTrackId:body.outTrackId,deliverResults:[{success:true,spaceId:'card-group',spaceType:'IM_GROUP'}]}});
  }) as typeof fetch;
  assert.ok(await sendRobotCard(credentials,card,templateId,fetcher));assert.equal(calls.length,2);
  let attempts=0;
  const failed=(async()=>{attempts++;return Response.json({success:true,result:{deliverResults:[{success:false,spaceId:'card-group',spaceType:'IM_GROUP'}]}});}) as typeof fetch;
  await assert.rejects(()=>sendRobotCard(credentials,card,templateId,failed),/未确认/);assert.equal(attempts,1);
  await assert.rejects(()=>sendRobotCard(credentials,card,templateId,(async()=>new Response('',{status:403})) as typeof fetch),/互动卡片实例写权限/);
});
test('配置模板后走卡片传输并记录受理张数；未配置继续文字通知',async()=>{
  const previous=process.env.DINGTALK_CARD_TEMPLATE_ID,fetcher=globalThis.fetch;
  try {
    process.env.DINGTALK_CARD_TEMPLATE_ID=templateId;assert.equal(cardTemplateId(),apiTemplateId);
    let uploads=0,deliveries=0,accepted=0;
    globalThis.fetch=(async(url:unknown,options:RequestInit)=>{
      if(String(url).includes('/media/upload')){uploads++;throw Error('不应上传图片');}
      if(String(url).includes('/createAndDeliver')){deliveries++;const body=JSON.parse(options.body as string);assert.equal(body.cardTemplateId,apiTemplateId);return Response.json({success:true,result:{outTrackId:body.outTrackId,deliverResults:[{success:true,spaceId:credentials.openConversationId,spaceType:'IM_GROUP'}]}});}
      throw Error('禁止外部请求');
    }) as typeof fetch;
    await sendInventoryReport(credentials,{messages:['mock text'],cards:[card]},undefined,parts=>accepted=parts);
    assert.equal(uploads,0);assert.equal(deliveries,1);assert.equal(accepted,1);
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
  await assert.rejects(()=>sendRobotCard(credentials,card,'',fetcher),/不能为空/);
  await assert.rejects(()=>sendRobotCard(credentials,card,'invalid',fetcher),/格式无效/);
  assert.equal(calls,0);
});

test('卡片400显示具体错误码、模板提示和请求编号；403与超时分类且不泄露响应凭证',async()=>{
  const reject=async(status:number,body:unknown)=>{
    let calls=0;
    const fetcher=(async()=>{
      calls++;
      return typeof body==='string' ? new Response(body,{status}) : Response.json(body,{status});
    }) as typeof fetch;
    let captured:unknown;
    try {await sendRobotCard(credentials,card,templateId,fetcher);}catch(error){captured=error;}
    assert.equal(calls,1,'失败不自动重试');assert.ok(captured instanceof DingTalkCardError);
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

test('原生卡片保持精确数值、负销量和零销量；缺日不补零且不跨缺日连接',()=>{
  const exact=structuredClone(card);exact.rows[0].quantity='9007199254740993.125';exact.rows[0].sales=['0','-2',null,'1.125','9007199254740993.125','4','6'];
  const params=nativeCardParams(exact),data=JSON.parse(params.rows);
  assert.equal(data[0].quantity,'9007199254740993.125');assert.equal(data[0].salesDetail,undefined);
  assert.deepEqual(data[0].chart.data.map((p:{y:number})=>p.y),[0,-2,1.125,4,6]);
  assert.notEqual(data[0].chart.data[1].type,data[0].chart.data[2].type);
  assert.notEqual(data[0].chart.data[2].type,data[0].chart.data[3].type);
  assert.deepEqual(data[0].chart.config,{xAxisConfig:{ticks:[]},yAxisConfig:{ticks:[]},padding:[4,4,4,4]});
  assert.ok(JSON.parse(nativeCardParams(card).rows)[0].chart.data.every((p:Record<string,unknown>)=>p.type===undefined),'完整单条曲线不附带重复图例');
  assert.ok(Object.values(params).every(p=>typeof p==='string'));assert.equal(params.reportImage,undefined);
});

test('原生卡片每款一行、统一表头，小曲线开启原生详情，不含图片或每日销量面板',()=>{
  const exported=JSON.parse(readFileSync('docs/dingtalk-inventory-card.json','utf8')),editor=JSON.parse(exported.editorData);
  type TemplateNode={componentName:string;id:string;props:{listData?:{variable:string};data?:{variable:string};enableDetail?:boolean;direction?:string;height?:number;text?:{content:string}};children?:TemplateNode[]};
  const nodes:TemplateNode[]=[];
  const walk=(n:TemplateNode)=>{nodes.push(n);for(const child of n.children||[])walk(child);};walk(editor.schema.componentsTree[0]);
  assert.ok(!nodes.some(n=>n.componentName==='Image'||n.componentName==='CollapsePanel'));
  const loop=nodes.find(n=>n.componentName==='Loop')!,chart=nodes.find(n=>n.componentName==='Chart')!;
  assert.equal(loop.props.listData?.variable,'rows');assert.equal(chart.props.data?.variable,'rows[0].chart');assert.equal(chart.props.enableDetail,true);
  assert.equal(chart.props.height,42);assert.equal(loop.children!.length,1);assert.equal(loop.children![0].props.direction,'horizontal');assert.equal(loop.children![0].children!.length,5);
  assert.equal(new Set(nodes.map(n=>n.id)).size,nodes.length);
  const variables=editor.variableList.find((v:{name:string})=>v.name==='rows');assert.equal(variables.type,'loopArray');assert.equal(variables.schema.find((v:{name:string})=>v.name==='chart').type,'chart');
  assert.match(exported.widgetInfo,/<DDChartView/);assert.match(exported.widgetInfo,/dataPath/);assert.doesNotMatch(exported.widgetInfo,/<ImageView/);
  assert.ok(editor.mockData.cardData.rows.some((r:{chart:{data:{y:number}[]}})=>r.chart.data.some(p=>p.y<0)));
});

test('循环文字使用官方 loop 上下文，两个商品分别渲染真实编码与精确数值，不留下参数字面量',()=>{
  const exported=JSON.parse(readFileSync('docs/dingtalk-inventory-card.json','utf8')),editor=JSON.parse(exported.editorData);
  type Node={componentName:string;id:string;props:{text?:{content:string};hoverText?:{content:string}};children?:Node[]};
  const nodes:Node[]=[];const walk=(node:Node)=>{nodes.push(node);node.children?.forEach(walk);};walk(editor.schema.componentsTree[0]);
  const values=JSON.parse(nativeCardParams(card).rows) as Record<string,string>[];
  for(const field of ['goodsNo','quantity','average','turnover']){
    const id=field==='goodsNo'?'code':field;
    const text=nodes.find(n=>n.id===`node_inventory_${id}`)!.props.text!.content;
    assert.equal(text,'${loop.'+field+'}');
    const rendered=values.slice(0,2).map(row=>text.replace(/\$\{loop\.(\w+)\}/g,(_match,key)=>row[key]));
    assert.deepEqual(rendered,values.slice(0,2).map(row=>row[field]));assert.ok(rendered.every(value=>!value.includes('${')));
    assert.ok(exported.widgetInfo.includes(`@subdata{'${field}'}`));
  }
  const loopTexts=nodes.filter(n=>n.componentName==='BaseText'&&n.props.text?.content.includes('loop.'));
  assert.equal(loopTexts.length,4);assert.doesNotMatch(exported.editorData,/\$\{rows\[0\]\./);
});
