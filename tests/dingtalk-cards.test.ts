import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { turnoverCards, cardTemplateId, normalizeCardTemplateId, nativeCardParams } from "../lib/dingtalk-card-data";
import { turnoverCardSvg, renderTurnoverCard } from "../lib/dingtalk-card-image";
import { DingTalkCardError, sendRobotCard, sendInventoryReport } from "../lib/dingtalk-cards";
import { turnoverAlertRows } from "../lib/dingtalk";
import type { InventoryView } from "../lib/inventory-types";

const rows = (count: number): InventoryView["rows"] => Array.from({length:count},(_,i)=>({goodsNo:`C.Q.CB.AP.00.${String(i+1).padStart(4,'0')}`,goodsName:'卡片预览示例',unitName:'Pcs',skuCount:1,quantity:String(40+i),history:{},sales:Object.fromEntries([3,6,11,-2,15,36,1].map((q,j)=>[`2026-10-0${j+1}`,String(q)])),metrics:{total7:'70',average7:'10',turnoverDays:'4',validDays:7,basis:'inbound_adjusted_difference',reason:null}}));
const card=turnoverCards(rows(5),'3','测试仓（CK031）','2026-10-08T00:00:23Z')[0];
const templateId='957e3c25-a2d9-4cd3-a424-be40f18a9f9b';
const apiTemplateId=templateId+'.schema';
const credentials={clientId:'card-test',clientSecret:'isolated-card-secret',robotCode:'card-robot',openConversationId:'card-group'};

test('本地地址、空地址和HTTP配置均不阻止原生卡片发送',async()=>{
  const previous=process.env.INVENTORY_SITE_URL;let sends=0;
  const fetcher=(async(url:unknown,options:RequestInit)=>{
    if(String(url).includes('/oauth2/'))return Response.json({accessToken:'local-card-token',expireIn:7200});
    sends++;const body=JSON.parse(options.body as string),fields=JSON.parse(body.cardData.cardParamMap.rows);
    assert.equal(fields[0].chart.type,'lineChart');assert.equal(fields[0].chartThumbnail,undefined);
    return Response.json({success:true,result:{outTrackId:body.outTrackId,deliverResults:[{success:true,spaceId:credentials.openConversationId,spaceType:'IM_GROUP'}]}});
  }) as typeof fetch;
  try {for(const address of ['', 'http://localhost:3108', 'http\\://localhost:3108']){
    process.env.INVENTORY_SITE_URL=address;await sendRobotCard({...credentials,clientId:'local-address-test'},card,templateId,fetcher);
  }assert.equal(sends,3);}finally{if(previous===undefined)delete process.env.INVENTORY_SITE_URL;else process.env.INVENTORY_SITE_URL=previous;}
});

test('令牌阶段失败确定未投放，投放超时或网络异常保留未确认并给出安全原因',async()=>{
  let calls=0;
  await assert.rejects(()=>sendRobotCard({...credentials,clientId:'token-stage-failure'},card,templateId,(async()=>{calls++;throw Error('private credential isolated-card-secret');}) as typeof fetch),(error:unknown)=>{
    assert.ok(error instanceof DingTalkCardError);assert.equal(error.rejected,true);assert.match(error.message,/尚未发送.*访问令牌/);assert.doesNotMatch(error.message,/private|isolated-card-secret/);return true;
  });
  assert.equal(calls,1);
  for(const failure of [new DOMException('isolated-card-secret','TimeoutError'),new TypeError('https://private/?token=isolated-card-secret')]) {
    let sends=0;
    const fetcher=(async(url:unknown)=>{
      if(String(url).includes('/oauth2/'))return Response.json({accessToken:'mock-card-token',expireIn:7200});
      sends++;throw failure;
    }) as typeof fetch;
    await assert.rejects(()=>sendRobotCard({...credentials,clientId:'network-stage-failure'},card,templateId,fetcher),(error:unknown)=>{
      assert.ok(error instanceof DingTalkCardError);assert.equal(error.rejected,false);assert.match(error.message,/超时|网络请求异常/);assert.doesNotMatch(error.message,/private|isolated-card-secret|https:/);return true;
    });
    assert.equal(sends,1,'不自动重试可能已送达的请求');
  }
});

test('负库存预警进入完整单卡数据，按周转排序且均值门槛仍有效',()=>{
  const source=rows(24);
  source[23].quantity='-5';source[23].metrics={...source[23].metrics!,turnoverDays:'-0.5',reason:'negative_inventory'};
  source[22].quantity='-3';source[22].metrics={...source[22].metrics!,total7:'21',average7:'3',turnoverDays:'-1',reason:'negative_inventory'};
  const matching=turnoverAlertRows(source,'3');
  assert.equal(matching.length,23);assert.equal(matching[0].goodsNo,source[23].goodsNo);
  const report=turnoverCards(matching,'3','仓','2026-10-08T00:00:23Z');
  assert.equal(report.length,1);
  const payload=JSON.parse(nativeCardParams(report[0]).rows);
  assert.equal(payload.length,23);assert.equal(payload[0].quantity,'-5');assert.equal(payload[0].turnover,'-0.5');
});

test('完整报表仅一张卡片，不丢失货品、负销量、精确数量或日期',()=>{
  const cards=turnoverCards(rows(1203),'3','全仓','2026-10-07T16:00:23Z');
  assert.equal(cards.length,1);assert.equal(cards[0].rows.length,1203);
  assert.deepEqual(turnoverCards([],"3","空仓","2026-10-08T00:00:23Z"),[]);
  assert.deepEqual(cards.flatMap(c=>c.rows.map(r=>r.goodsNo)),rows(1203).map(r=>r.goodsNo));
  assert.deepEqual(cards[0].dates,['2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07']);
  assert.equal(cards[0].rows[0].sales[3],'-2');assert.equal(cards[0].part,1);assert.equal(cards[0].totalParts,1);
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
test('投放原生卡片真实字段，不上传图片或依赖网站地址；验证群投放结果，无自动重试',async()=>{
  const calls:string[]=[];
  const fetcher=(async(url: unknown,options: RequestInit)=>{
    calls.push(String(url));
    if(String(url).includes('/oauth2/'))return Response.json({accessToken:'mock-card-token',expireIn:7200});
    assert.ok(String(url).includes('/createAndDeliver'));
    const body=JSON.parse(options.body as string);assert.equal(body.cardTemplateId,apiTemplateId);assert.equal(body.openSpaceId,'dtv1.card//IM_GROUP.card-group');assert.equal(body.imGroupOpenDeliverModel.robotCode,'card-robot');assert.equal(body.cardData.cardParamMap.reportImage,undefined);assert.equal(JSON.parse(body.cardData.cardParamMap.config).autoLayout,true);
    const dataRows=JSON.parse(body.cardData.cardParamMap.rows);assert.equal(dataRows.length,5);assert.equal(dataRows[0].chart.type,'lineChart');assert.equal(dataRows[0].chart.data[3].y,-2);assert.equal(dataRows[0].quantity,'40');assert.equal(dataRows[0].salesDetail,undefined);assert.equal(dataRows[0].chartThumbnail,undefined);assert.equal(dataRows[0].chartDetailUrl,undefined);
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
    await sendInventoryReport(credentials,{messages:['mock text'],cards:turnoverCards(rows(24),'3','仓','2026-10-08T00:00:23Z')},undefined,parts=>accepted=parts);
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
  assert.deepEqual(data[0].chart.config,{legend:false,lineShape:'smooth',color:'#5278D8',padding:[12,8,20,32],xAxisConfig:{type:'cat',tickCount:2},yAxisConfig:{tickCount:3,alias:'净销量'},xAxisOptions:{label:false},yAxisOptions:{label:true}});
  assert.ok(JSON.parse(nativeCardParams(card).rows)[0].chart.data.every((p:Record<string,unknown>)=>p.type===undefined),'完整单条曲线不附带重复图例');
  assert.ok(Object.values(params).every(p=>typeof p==='string'));assert.equal(params.reportImage,undefined);
});

test('原生卡片桌面保留表格、手机完整编码与原生趋势入口，两端列表默认折叠且可展开',()=>{
  const exported=JSON.parse(readFileSync('docs/dingtalk-inventory-card.json','utf8')),editor=JSON.parse(exported.editorData);
  type TemplateNode={componentName:string;id:string;props:{listData?:{variable:string};data?:{variable:string};enableDetail?:boolean;direction?:string;height?:number;text?:{content:string}};children?:TemplateNode[]};
  const nodes:TemplateNode[]=[];
  const walk=(n:TemplateNode)=>{nodes.push(n);for(const child of n.children||[])walk(child);};walk(editor.schema.componentsTree[0]);
  assert.equal(nodes.filter(n=>n.componentName==='CollapsePanel').length,2);
  assert.equal(nodes.filter(n=>n.componentName==='Image').length,0);
  const loop=nodes.find(n=>n.componentName==='Loop')!,chart=nodes.find(n=>n.componentName==='Chart')!;
  assert.equal(loop.props.listData?.variable,'rows');assert.equal(chart.props.data?.variable,'rows[0].chart');assert.equal(chart.props.enableDetail,true);
  assert.equal(chart.props.height,64);assert.equal(loop.children!.length,1);assert.equal(loop.children![0].props.direction,'horizontal');assert.equal(loop.children![0].children!.length,5);
  const mobileLoop=nodes.find(n=>n.id==='node_inventory_mobile_rows')!;
  assert.equal(mobileLoop.props.listData?.variable,'rows');assert.equal(mobileLoop.children![0].props.direction,'vertical');
  const entry=nodes.find(n=>n.id==='node_inventory_mobile_chart_cell')! as unknown as {props:{url:{variable:string}};children:TemplateNode[]};
  assert.equal(entry.props.url.variable,'nativeTrendDetailLink');assert.equal(entry.children.length,1);assert.equal(entry.children[0].props.text?.content,'7天趋势');
  assert.equal(nodes.filter(n=>n.componentName==='Chart').length,1,'手机不保留空白图表区域');
  const nativeLink=editor.variableList.find((v:{id:string})=>v.id==='nativeTrendDetailLink');
  assert.match(nativeLink.hardCodeValue,/data.cardInstanceId/);assert.match(nativeLink.hardCodeValue,/index_of/);assert.match(JSON.stringify(nativeLink.durboSchema),/CARD_INSTANCE_ID/);
  assert.equal(editor.schema.componentsTree[0].props.autoFoldConfig.needFold,false);
  for(const panel of nodes.filter(n=>n.componentName==='CollapsePanel') as unknown as {props:{contentVisible:boolean}}[])assert.equal(panel.props.contentVisible,false);
  assert.match(exported.widgetInfo,/dtSendOutData/);assert.match(exported.widgetInfo,/inventory-report-desktop/);assert.match(exported.widgetInfo,/inventory-report-mobile/);
  assert.match(exported.widgetInfo,/interactive-card-chart-fe/);assert.doesNotMatch(exported.widgetInfo,/chartThumbnail|chartDetailUrl|api\/alerts\/trend/);
  assert.equal(new Set(nodes.map(n=>n.id)).size,nodes.length);
  const desktopLayout=nodes.find(n=>n.id==='node_inventory_desktop_layout')!,mobileLayout=nodes.find(n=>n.id==='node_inventory_mobile_layout')!;
  const layouts=[desktopLayout,mobileLayout] as unknown as {props:{isFixedWidth:boolean;width:number;visible:{condition:{conditions:{type:string;platform:string[]}[]}}}}[];
  assert.equal(layouts[0].props.isFixedWidth,true);assert.equal(layouts[0].props.width,640);
  assert.equal(layouts[1].props.isFixedWidth,false,'手机不能继承桌面的固定宽度');
  for(const [layout,platform] of layouts.map((layout,i)=>[layout,i===0?['pc']:['ios','android']] as const)){
    assert.deepEqual(layout.props.visible.condition.conditions,[{type:'env',platform,version:Object.fromEntries(platform.map(p=>[p,{op:'all'}]))}]);
  }
  assert.ok(!editor.expList.some((v:{name:string})=>v.name==='mobileLayout'),'使用客户端环境条件，不从报告数据读取 env');
  const variables=editor.variableList.find((v:{name:string})=>v.name==='rows');assert.equal(variables.type,'loopArray');assert.equal(variables.schema.find((v:{name:string})=>v.name==='chart').type,'chart');
  assert.match(exported.widgetInfo,/<DDChartView/);assert.match(exported.widgetInfo,/dataPath/);assert.doesNotMatch(exported.widgetInfo,/reportImage/);
  assert.ok(editor.mockData.cardData.rows.some((r:{chart:{data:{y:number}[]}})=>r.chart.data.some(p=>p.y<0)));
});

test('循环文字使用官方 loop 上下文，两个商品分别渲染真实编码与精确数值，不留下参数字面量',()=>{
  const exported=JSON.parse(readFileSync('docs/dingtalk-inventory-card.json','utf8')),editor=JSON.parse(exported.editorData);
  const xml=exported.widgetInfo.replace(/&#039;/g,"'");
  type Node={componentName:string;id:string;props:{text?:{content:string};hoverText?:{content:string}};children?:Node[]};
  const nodes:Node[]=[];const walk=(node:Node)=>{nodes.push(node);node.children?.forEach(walk);};walk(editor.schema.componentsTree[0]);
  const values=JSON.parse(nativeCardParams(card).rows) as Record<string,string>[];
  for(const field of ['goodsNo','quantity','average','turnover']){
    const id=field==='goodsNo'?'code':field;
    const text=nodes.find(n=>n.id===`node_inventory_${id}`)!.props.text!.content;
    assert.equal(text,'${loop.'+field+'}');
    const rendered=values.slice(0,2).map(row=>text.replace(/\$\{loop\.(\w+)\}/g,(_match,key)=>row[key]));
    assert.deepEqual(rendered,values.slice(0,2).map(row=>row[field]));assert.ok(rendered.every(value=>!value.includes('${')));
    assert.ok(xml.includes(`@subdata{'${field}'}`));
  }
  const loopTexts=nodes.filter(n=>n.componentName==='BaseText'&&n.props.text?.content.includes('loop.'));
  assert.equal(loopTexts.length,8);assert.doesNotMatch(exported.editorData,/\$\{rows\[0\]\./);
});
