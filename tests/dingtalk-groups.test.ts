import assert from 'node:assert/strict';
import test from 'node:test';
import { queryRobotGroups, queryRobotGroupName } from '../lib/dingtalk-groups-api';

test('机器人所在群按游标完整分页、去重，与发送消息完全分离',async()=>{
  const bodies: Record<string,unknown>[]=[];
  const fetcher: typeof fetch=async(url,options)=>{
    if(String(url).endsWith('/accessToken')) return Response.json({accessToken:'test-query-token',expireIn:7200});
    assert.ok(String(url).endsWith('/v1.0/robot/installed/groups/query'));
    assert.equal(new Headers(options?.headers).get('x-acs-dingtalk-access-token'),'test-query-token');
    bodies.push(JSON.parse(String(options?.body)));
    return Response.json(bodies.length===1 ? {hasMore:true,nextToken:'page2',openConversationIds:['cid-1','cid-2']} : {hasMore:false,openConversationIds:['cid-2','cid-3']});
  };
  assert.deepEqual(await queryRobotGroups({clientId:'groups-unit-1',clientSecret:'fake-secret',robotCode:'fake-robot'},fetcher),['cid-1','cid-2','cid-3']);
  assert.deepEqual(bodies,[{robotCode:'fake-robot',maxResult:10},{robotCode:'fake-robot',maxResult:10,nextToken:'page2'}]);
});

test('分页缺失、重复游标、权限失败、无效ID都拒绝返回部分群列表',async()=>{
  for(const result of [{hasMore:true,openConversationIds:['cid-1']},{hasMore:false,openConversationIds:['']},{hasMore:false},{openConversationIds:[]}]) {
    const fetcher: typeof fetch=async(url)=>String(url).endsWith('/accessToken') ? Response.json({accessToken:'fake',expireIn:7200}) : Response.json(result);
    await assert.rejects(()=>queryRobotGroups({clientId:'groups-unit-2',clientSecret:'fake',robotCode:'r'},fetcher),/群/);
  }
  const repeated: typeof fetch=async()=>Response.json({hasMore:true,nextToken:'same',openConversationIds:['cid-1']});
  await assert.rejects(()=>queryRobotGroups({clientId:'groups-unit-2',clientSecret:'fake',robotCode:'r'},repeated),/分页异常/);
  await assert.rejects(()=>queryRobotGroups({clientId:'groups-unit-2',clientSecret:'fake',robotCode:'r'},async()=>new Response('private details',{status:403})),/HTTP 403/);
});

test('空群列表是有效完整结果；名称只接受同一群的标题',async()=>{
  const credentials={clientId:'groups-unit-3',clientSecret:'fake',robotCode:'r'};
  const fetcher: typeof fetch=async(url)=>String(url).endsWith('/accessToken') ? Response.json({accessToken:'fake',expireIn:7200}) : Response.json({hasMore:false,openConversationIds:[]});
  assert.deepEqual(await queryRobotGroups(credentials,fetcher),[]);
  assert.equal(await queryRobotGroupName(credentials,'cid-1',async()=>Response.json({success:true,title:'库存通知群',openConversationId:'cid-1'})),'库存通知群');
  await assert.rejects(()=>queryRobotGroupName(credentials,'cid-1',async()=>Response.json({title:'other',openConversationId:'cid-2'})),/群名称/);
});
