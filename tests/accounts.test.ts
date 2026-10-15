import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { sqlite } from '../lib/sqlite.mjs';
import { AccessError, accountById, bindCompanyAccount, groupAllowed, legacyAccount, manageAccount, assertOwnerActive } from '../lib/accounts';
import { beginDingLogin, consumeDingLogin, ensureOwnerAccess, NotCompanyMember, verifyCompanyLogin } from '../lib/dingtalk-login';
import { addWarehouse, loadInventory, loadWarehouses } from '../lib/inventory-store';
import { settings, saveSettings } from '../lib/alerts-store';
import { saveGroupGrants } from '../lib/account-groups';
import { groupState } from '../lib/dingtalk-groups-store';
import { enqueue, enqueueDaily } from '../lib/local-jobs';
import { attachReportExport, readReportExport } from '../lib/alert-report-export';
import { assertDelivery } from '../lib/notification-guard';
import { sendInventoryReport } from '../lib/dingtalk-cards';
import type { TurnoverCard } from '../lib/dingtalk-card-data';

mkdirSync('.sites-runtime/tests',{recursive:true});
process.env.INVENTORY_DB_PATH=resolve(`.sites-runtime/tests/accounts-${Date.now()}.sqlite`);
Object.assign(process.env,{INVENTORY_SITE_URL:'https://inventory.example.test',INVENTORY_OWNER_ID:'historic-admin',DINGTALK_CORP_ID:'test-corp',DINGTALK_ADMIN_UNION_ID:'union-admin',DINGTALK_LOGIN_CLIENT_ID:'login-app-test',DINGTALK_LOGIN_CLIENT_SECRET:'offline-test-secret',DINGTALK_CLIENT_ID:'robot-test',DINGTALK_CLIENT_SECRET:'offline-robot-secret',DINGTALK_ROBOT_CODE:'robot-test'});
delete process.env.DINGTALK_ADMIN_USER_ID;
const identity=(id:string)=>({corpId:'test-corp',userId:id,unionId:'union-'+id,name:'成员 '+id,avatar:''});

test('账户迁移、独立空间、群授权、会话与任务撤销',async t=>{
  process.env.INVENTORY_DINGTALK_LOGIN_ENABLED='false';
  const legacy=legacyAccount();await addWarehouse(legacy.data_owner,'OLD','原有仓库');
  process.env.INVENTORY_DINGTALK_LOGIN_ENABLED='true';
  const a=bindCompanyAccount(identity('a')),b=bindCompanyAccount(identity('b'));
  const admin=bindCompanyAccount({...identity('admin'),name:'指定管理员'});
  const db=sqlite();
  await t.test('员工先登录不成为管理员；指定身份继承历史 owner，不复制历史',async()=>{
    assert.equal(a.role,'member');assert.equal(admin.role,'admin');assert.equal(admin.id,legacy.id);assert.equal(admin.data_owner,'historic-admin');
    assert.ok((await loadWarehouses(admin.data_owner)).some(w=>w.code==='OLD'));
    assert.deepEqual(await loadWarehouses(a.data_owner),[]);assert.deepEqual(await loadWarehouses(b.data_owner),[]);
    assert.throws(()=>bindCompanyAccount({...identity('x'),corpId:'other-corp'}),AccessError);
    assert.throws(()=>bindCompanyAccount({...identity('a'),unionId:'different-person'}),AccessError);
  });
  await t.test('同仓库编码拥有独立配置和库存快照，猜测对方仓库无效',async()=>{
    await addWarehouse(a.data_owner,'SAME','A的仓库');await addWarehouse(b.data_owner,'SAME','B的仓库');await addWarehouse(a.data_owner,'ONLY_A','A独有');
    await saveSettings(a.data_owner,false,'0','9',[],undefined,{warehouseCode:'SAME'});
    assert.equal((await settings(b.data_owner,'SAME')).turnoverAverageThreshold,'3');assert.equal((await settings(a.data_owner,'SAME')).turnoverAverageThreshold,'9');
    for(const [account,quantity] of [[a,'123'],[b,'456']] as const){
      const id='snapshot-'+account.id;
      db.prepare("INSERT INTO stock_snapshots(id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,coverage) VALUES(?,?,?,?,'complete',1,1,1,'{}',0,0,'SAME','auto:v1')").run(id,account.data_owner,'2026-10-15','2026-10-15T00:00:00Z');
      db.prepare("INSERT INTO stock_entries(snapshot_id,goods_no,goods_name,unit_name,quantity,sku_count,sign) VALUES(?,'GOODS','货品','件',?,1,1)").run(id,quantity);
    }
    assert.equal((await loadInventory(a.data_owner,{warehouseCode:'SAME'})).rows[0].quantity,'123');assert.equal((await loadInventory(b.data_owner,{warehouseCode:'SAME'})).rows[0].quantity,'456');
    await assert.rejects(()=>loadInventory(b.data_owner,{warehouseCode:'ONLY_A'}),/仓库尚未添加/);
  });
  await t.test('新成员看不到企业群；授权与撤销影响选择和发送',async()=>{
    for(const id of ['g1','g2'])db.prepare('INSERT INTO dingtalk_groups(owner,client_id,robot_code,open_conversation_id,name,last_seen_at) VALUES(?,?,?,?,?,?)').run(admin.data_owner,'robot-test','robot-test',id,id,new Date().toISOString());
    assert.deepEqual(groupState(a.data_owner).groups,[]);assert.equal(groupAllowed(a.data_owner,'g1'),false);
    saveGroupGrants(admin,a.id,['g1']);assert.deepEqual(groupState(a.data_owner).groups.map(g=>g.id),['g1']);assert.equal(groupAllowed(a.data_owner,'g2'),false);
    assert.throws(()=>saveGroupGrants(a,b.id,['g1']),/管理员/);
    await saveSettings(a.data_owner,true,'0','9',['g1'],undefined,{warehouseCode:'SAME'});
    const revision=(await settings(a.data_owner,'SAME')).revision;await assertDelivery(a.data_owner,'SAME','g1',revision);
    db.prepare('INSERT INTO enterprise_robot_sync VALUES(?,?,?)').run('robot-test','robot-test',new Date().toISOString());
    assert.equal(groupAllowed(a.data_owner,'g1'),false,'企业目录已核验为空时，旧成员缓存不能继续放行');
    db.prepare('INSERT INTO enterprise_robot_groups VALUES(?,?,?,?,?,?)').run('robot-test','robot-test','g1','测试群',1,new Date().toISOString());assert.equal(groupAllowed(a.data_owner,'g1'),true);
    db.prepare('UPDATE enterprise_robot_groups SET active=0').run();await assert.rejects(()=>assertDelivery(a.data_owner,'SAME','g1',revision),/群授权已撤销/);
    db.prepare('UPDATE enterprise_robot_groups SET active=1').run();
    saveGroupGrants(admin,a.id,[]);assert.deepEqual((await settings(a.data_owner,'SAME')).groupState.groups.filter(g=>g.enabled),[]);
    await assert.rejects(()=>assertDelivery(a.data_owner,'SAME','g1',revision),/群授权已撤销/);
  });
  await t.test('报告下载必须有归属授权，匿名和其他成员即使持有令牌也不可下载',()=>{
    const card:TurnoverCard={title:'test',summary:'',footer:'',dates:[],totalCount:0,part:1,totalParts:1,rows:[]};
    const report=attachReportExport(a.data_owner,'SAME',{cards:[card]}),token=new URL(report.cards[0].exportUrl!).pathname.split('/').at(-1)!;
    assert.equal(readReportExport(token),null);assert.equal(readReportExport(token,{owner:b.data_owner}),null);assert.ok(readReportExport(token,{owner:a.data_owner}));assert.ok(readReportExport(token,{owner:admin.data_owner,admin:true}));
    db.prepare('UPDATE alert_report_exports SET expires_at=0').run();assert.equal(readReportExport(token,{owner:a.data_owner}),null);
  });
  await t.test('禁用撤销现有会话、取消排队任务；再次钉钉登录不会重新启用',async()=>{
    enqueue(a.data_owner,'SAME');db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?)').run('test-session',a.id,Date.now()+10000,Date.now());
    manageAccount(admin,a.id,{status:'disabled'});assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_sessions WHERE account_id=?').get(a.id)!.n,0);assert.equal(db.prepare('SELECT state FROM local_jobs WHERE owner=?').get(a.data_owner)!.state,'failed');
    assert.throws(()=>bindCompanyAccount(identity('a')),/禁用/);assert.throws(()=>enqueue(a.data_owner,'SAME'),/不可用/);await assert.rejects(()=>ensureOwnerAccess(a.data_owner),/不可用/);
    enqueueDaily('2026-10-15 23:59:00');assert.equal(db.prepare("SELECT COUNT(*) AS n FROM local_jobs WHERE owner=? AND state='queued'").get(a.data_owner)!.n,0);
    manageAccount(admin,a.id,{status:'active'});assert.equal(bindCompanyAccount(identity('a')).status,'active');
  });
  await t.test('最后一名管理员不可降权/禁用；并发式顺序变更仍保留有效管理员',()=>{
    assert.throws(()=>manageAccount(admin,admin.id,{role:'member'}),/至少一名/);assert.throws(()=>manageAccount(admin,admin.id,{status:'archived'}),/至少一名/);
    manageAccount(admin,b.id,{role:'admin'});manageAccount(admin,b.id,{role:'member'});assert.throws(()=>manageAccount(admin,admin.id,{status:'disabled'}),/至少一名/);
    assert.throws(()=>manageAccount(a,admin.id,{role:'member'}),/管理员权限/);
  });
  await t.test('分段通知在账户禁用后不继续发送下一段',async()=>{
    let sent=0;await assert.rejects(()=>sendInventoryReport({clientId:'x',clientSecret:'offline',robotCode:'x',openConversationId:'g'},{cards:[],messages:['one','two']},async()=>{sent++;manageAccount(admin,a.id,{status:'disabled'});return 'accepted';},undefined,()=>ensureOwnerAccess(a.data_owner)),/不可用/);assert.equal(sent,1);manageAccount(admin,a.id,{status:'active'});
  });
  await t.test('过期的成员核验遇到网络故障不会放行；离职核验撤销会话',async()=>{
    const original=globalThis.fetch;db.prepare('UPDATE accounts SET membership_checked_at=0 WHERE id=?').run(a.id);
    try{
      globalThis.fetch=async()=>{throw new Error('offline');};await assert.rejects(()=>ensureOwnerAccess(a.data_owner),/暂时无法核验/);assert.equal(accountById(a.id)!.membership_checked_at,0);
      globalThis.fetch=async url=>String(url).includes('/oauth2/accessToken')?Response.json({accessToken:'offline-token'}):Response.json({errcode:60121});
      db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?)').run('departed-session',a.id,Date.now()+10000,Date.now());
      await assert.rejects(()=>ensureOwnerAccess(a.data_owner),NotCompanyMember);assert.equal(accountById(a.id)!.member_state,'departed');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_sessions WHERE account_id=?').get(a.id)!.n,0);assert.throws(()=>assertOwnerActive(a.data_owner),/不可用/);
    }finally{globalThis.fetch=original;}
  });
  process.env.INVENTORY_DINGTALK_LOGIN_ENABLED='false';
  assert.throws(()=>assertOwnerActive(b.data_owner),/钉钉登录已关闭/);assert.doesNotThrow(()=>assertOwnerActive(admin.data_owner));
  process.env.INVENTORY_DINGTALK_LOGIN_ENABLED='true';
});

test('OAuth 校验绑定浏览器、过期、一次性和安全回跳',()=>{
  const login=beginDingLogin('/admin/accounts'),u=new URL(login.url),state=u.searchParams.get('state')!;
  assert.equal(u.searchParams.get('scope'),'openid corpid');assert.equal(u.searchParams.get('corpId'),'test-corp');
  assert.throws(()=>consumeDingLogin(state,'x'.repeat(43)),/过期|校验/);assert.equal(consumeDingLogin(state,login.browser),'/admin/accounts');assert.throws(()=>consumeDingLogin(state,login.browser),/过期|使用/);
  const expired=beginDingLogin();sqlite().prepare('UPDATE login_transactions SET expires_at=0').run();assert.throws(()=>consumeDingLogin(new URL(expired.url).searchParams.get('state')!,expired.browser),/过期/);
  for(const path of ['//evil.test','/\\evil.test','/\n/evil.test','https://evil.test']){const x=beginDingLogin(path);assert.equal(consumeDingLogin(new URL(x.url).searchParams.get('state')!,x.browser),'/');}
});

test('钉钉授权后还必须核验公司、unionId 映射和企业通讯录成员',async()=>{
  let badCorp=false,badUser=false,denied=false;
  const fetcher:typeof fetch=async(url,options)=>{
    const path=new URL(String(url)).pathname;
    if(path.endsWith('/userAccessToken')){assert.equal(JSON.parse(String(options?.body)).grantType,'authorization_code');return Response.json({accessToken:'user-token',corpId:badCorp?'other-corp':'test-corp'});}
    if(path.endsWith('/users/me'))return Response.json({unionId:'union-test'});
    if(path.endsWith('/accessToken'))return Response.json({accessToken:'company-token'});
    if(path.endsWith('/getbyunionid'))return Response.json({errcode:0,result:{userid:'test'}});
    if(path.endsWith('/v2/user/get'))return Response.json(denied?{errcode:40014}:{errcode:0,result:{userid:'test',unionid:badUser?'different':'union-test',dept_id_list:[1],name:'测试用户'}});
    throw new Error('unexpected API');
  };
  assert.equal((await verifyCompanyLogin('code',fetcher)).userId,'test');badCorp=true;await assert.rejects(()=>verifyCompanyLogin('code',fetcher),NotCompanyMember);badCorp=false;badUser=true;await assert.rejects(()=>verifyCompanyLogin('code',fetcher),NotCompanyMember);badUser=false;denied=true;await assert.rejects(()=>verifyCompanyLogin('code',fetcher),/通讯录核验失败/);
});
