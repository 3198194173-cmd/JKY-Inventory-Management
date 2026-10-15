import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { sqlite } from '../lib/sqlite.mjs';
import { bindCompanyAccount, accountById, assertOwnerActive, manageAccount, type CompanyIdentity } from '../lib/accounts';
import { lookupCompanyMobile, normalizeCompanyMobile } from '../lib/dingtalk-login';
import { findShareRecipient, shareWarehouses, warehouseShareOptions } from '../lib/warehouse-sharing';

mkdirSync('.sites-runtime/tests',{recursive:true});
Object.assign(process.env,{INVENTORY_DB_PATH:resolve(`.sites-runtime/tests/sharing-${randomUUID()}.sqlite`),INVENTORY_DINGTALK_LOGIN_ENABLED:'true',INVENTORY_OWNER_ID:'test-owner',DINGTALK_CORP_ID:'share-corp',DINGTALK_ADMIN_UNION_ID:'share-admin',DINGTALK_LOGIN_CLIENT_ID:'offline-app',DINGTALK_LOGIN_CLIENT_SECRET:'offline-test-only',INVENTORY_SITE_URL:'https://inventory.example.test'});
delete process.env.DINGTALK_ADMIN_USER_ID;
const person=(id:string):CompanyIdentity=>({corpId:'share-corp',userId:id,unionId:id==='admin'?'share-admin':'union-'+id,name:'测试成员 '+id,avatar:''});
let calls=0;
function directory(id='new',options:{error?:number;union?:string;noDepartment?:boolean}={}):typeof fetch{
  return (async(url,init)=>{
    calls++;const path=new URL(String(url)).pathname;
    if(path.endsWith('/oauth2/accessToken'))return Response.json({accessToken:'offline-company-token'});
    if(options.error)return Response.json({errcode:options.error,errmsg:'upstream private detail'});
    if(path.endsWith('/getbymobile')){assert.equal(JSON.parse(String(init?.body)).mobile,'13900000001');return Response.json({errcode:0,result:{userid:id}});}
    assert.equal(path,'/topapi/v2/user/get');assert.equal(JSON.parse(String(init?.body)).userid,id);
    return Response.json({errcode:0,result:{userid:id,unionid:options.union||person(id).unionId,name:person(id).name,dept_id_list:options.noDepartment?[]:[1]}});
  }) as typeof fetch;
}
test('管理员手机号查人、预建账户和仓库历史独立复制',async t=>{
  const admin=bindCompanyAccount(person('admin')),member=bindCompanyAccount(person('member')),db=sqlite();
  for(const code of ['COPY','SKIP'])db.prepare('INSERT INTO warehouses(owner,code,name,warehouse_id,schedule_enabled,daily_time,time_zone,created_at) VALUES(?,?,?,?,?,?,?,?)').run(admin.data_owner,code,'源仓库'+code,'erp-'+code,1,'09:10','Asia/Shanghai','2026-10-01');
  db.prepare('INSERT INTO warehouses(owner,code,name,created_at) VALUES(?,?,?,?)').run(member.data_owner,'SKIP','接收人已有仓库','2026-10-02');
  for(const [id,date,status] of [['s1','2026-10-13','complete'],['s2','2026-10-14','complete'],['unfinished','2026-10-15','running']]){
    db.prepare('INSERT INTO stock_snapshots(id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,coverage) VALUES(?,?,?,?,?,1,1,1,?,0,1,?,?)').run(id,admin.data_owner,date,date+'T00:00:00Z',status,'{"件":"-12.34567890123456789"}','COPY','auto:v1');
    db.prepare('INSERT INTO stock_entries VALUES(?,?,?,?,?,?,?)').run(id,'TEST-GOODS','测试货品','件','-12.34567890123456789',1,-1);
    if(status==='complete')db.prepare('INSERT INTO daily_slots VALUES(?,?,?,?)').run(admin.data_owner,'COPY',date,id);
  }
  db.prepare(`INSERT INTO inbound_reconciliations(owner,warehouse_code,goods_no,date,before_snapshot_id,after_snapshot_id,unit_name,raw_difference,opening_quantity,closing_quantity,status,inbound_quantity,corrected_quantity,window_start,window_end,records,error,checked_at,query_scope)
    VALUES(?,'COPY','TEST-GOODS','2026-10-13','s1','s2','件','-1','10','11','verified','0','-1','start','end','[]',NULL,'2026-10-14','warehouse:v1')`).run(admin.data_owner);
  for(const [id,status,payload,error] of [['t1','complete','{"goods":[],"documents":[]}',null],['t2','unresolved',null,'未核验完成']])db.prepare('INSERT INTO transit_snapshots VALUES(?,?,?,?,?,?,?,?)').run(id,'s2',admin.data_owner,'COPY','2026-10-14',status,payload,error);
  db.prepare('INSERT INTO transit_completion_marks VALUES(?,?,?,?)').run(admin.data_owner,'COPY','TEST-GOODS','2026-10-14T01:00:00Z');
  db.prepare('INSERT INTO sync_runs(id,owner,status,started_at,completed_at,warehouse_code) VALUES(?,?,?,?,?,?)').run('s2',admin.data_owner,'complete','2026-10-14','2026-10-14','COPY');
  db.prepare('INSERT INTO sync_runs(id,owner,status,started_at,warehouse_code) VALUES(?,?,?,?,?)').run('active-run',admin.data_owner,'running','2026-10-15','COPY');
  db.prepare("UPDATE warehouse_alert_settings SET enabled=1,threshold='7',turnover_average_threshold='8',excluded_name_keywords='[\"包装\"]',notify_time='10:30',last_sent_at='yesterday',last_result='sent',revision=7 WHERE owner=? AND warehouse_code='COPY'").run(admin.data_owner);
  db.prepare('INSERT INTO warehouse_alert_groups VALUES(?,?,?,?,?)').run(admin.data_owner,'COPY','app','robot','group');

  await t.test('非管理员无法枚举或查询；手机号规范化、权限失败和非公司成员不误创建',async()=>{
    const before=calls;assert.throws(()=>warehouseShareOptions(member),/管理员/);
    await assert.rejects(()=>findShareRecipient(member,'13900000001',directory()),/管理员/);assert.equal(calls,before);
    assert.equal(normalizeCompanyMobile('+86-139 0000 0001'),'13900000001');assert.throws(()=>normalizeCompanyMobile('abc'),/手机号/);
    await assert.rejects(()=>lookupCompanyMobile('13900000001',directory('new',{error:60011})),/手机号姓名/);
    await assert.rejects(()=>lookupCompanyMobile('13900000001',directory('new',{error:40104})),/本公司/);
    await assert.rejects(()=>lookupCompanyMobile('13900000001',directory('new',{noDepartment:true})),/本公司/);
  });
  let proof:Awaited<ReturnType<typeof findShareRecipient>>;
  await t.test('查询不创建账户，凭证绑定管理员，手机号原文不落库',async()=>{
    proof=await findShareRecipient(admin,'+86-13900000001',directory());assert.equal(proof.maskedMobile,'139****0001');assert.equal(proof.existingAccount,false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE dingtalk_user_id='new'").get()!.n,0);
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM warehouse_share_candidates').all()).includes('13900000001'));
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM account_audit').all()).includes('13900000001'));
  });
  const requestId=randomUUID();let recipientId='';
  await t.test('原子复制完整历史，待首次登录，无发送权限和运行任务；重试幂等',async()=>{
    const input={requestId,lookupToken:proof.lookupToken,warehouseCodes:['COPY']};
    const result=await shareWarehouses(admin,input,directory());recipientId=result.targetId;
    assert.deepEqual(result.copied.map(x=>[x.snapshots,x.entries,x.inbound,x.transit]),[[2,2,1,2]]);
    assert.deepEqual(await shareWarehouses(admin,input,directory()),result);
    await assert.rejects(()=>shareWarehouses(admin,{...input,warehouseCodes:['SKIP']},directory()),/请求编号/);
    const recipient=accountById(recipientId)!;assert.equal(recipient.member_state,'prepared');assert.equal(recipient.last_login_at,null);assert.throws(()=>assertOwnerActive(recipient.data_owner),/不可用/);
    const snapshots=db.prepare('SELECT * FROM stock_snapshots WHERE owner=?').all(recipient.data_owner);assert.equal(snapshots.length,2);assert.ok(snapshots.every((s:{id:string})=>!['s1','s2'].includes(s.id)));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    const inbound=db.prepare('SELECT * FROM inbound_reconciliations WHERE owner=?').get(recipient.data_owner)!;assert.equal(inbound.corrected_quantity,'-1');assert.notEqual(inbound.before_snapshot_id,'s1');assert.notEqual(inbound.after_snapshot_id,'s2');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM daily_slots WHERE owner=?').get(recipient.data_owner)!.n,2);
    const ts=db.prepare('SELECT * FROM transit_snapshots WHERE owner=? ORDER BY captured_at,id').all(recipient.data_owner);assert.equal(ts.length,2);assert.equal(ts.find((x:{status:string})=>x.status==='unresolved')!.error,'未核验完成');
    assert.equal(db.prepare('SELECT completed_at FROM transit_completion_marks WHERE owner=?').get(recipient.data_owner)!.completed_at,'2026-10-14T01:00:00Z');
    const rule=db.prepare('SELECT * FROM warehouse_alert_settings WHERE owner=?').get(recipient.data_owner)!;assert.equal(rule.enabled,0);assert.equal(rule.threshold,'7');assert.equal(rule.notify_time,'10:30');assert.equal(rule.last_sent_at,null);assert.equal(rule.revision,0);
    for(const table of ['warehouse_alert_groups','local_jobs'])assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner=?`).get(recipient.data_owner)!.n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_group_grants WHERE data_owner=?').get(recipient.data_owner)!.n,0);
    const run=db.prepare('SELECT * FROM sync_runs WHERE owner=?').get(recipient.data_owner)!;assert.equal(run.trigger,'shared');assert.equal(run.id,inbound.after_snapshot_id);
  });
  await t.test('首次登录复用预建身份和数据；复制后的库存/设置彼此独立',()=>{
    const recipient=bindCompanyAccount(person('new'));assert.equal(recipient.id,recipientId);assert.equal(recipient.member_state,'verified');assert.ok(recipient.last_login_at);assertOwnerActive(recipient.data_owner);
    const entry=db.prepare('SELECT e.* FROM stock_entries e JOIN stock_snapshots s ON s.id=e.snapshot_id WHERE s.owner=? LIMIT 1').get(recipient.data_owner)!;
    assert.equal(entry.quantity,'-12.34567890123456789');db.prepare("UPDATE stock_entries SET quantity='900' WHERE snapshot_id=?").run(entry.snapshot_id);
    assert.equal(db.prepare("SELECT quantity FROM stock_entries WHERE snapshot_id='s1'").get()!.quantity,'-12.34567890123456789');
    db.prepare("UPDATE warehouse_alert_settings SET threshold='99' WHERE owner=?").run(recipient.data_owner);
    assert.equal(db.prepare("SELECT threshold FROM warehouse_alert_settings WHERE owner=? AND warehouse_code='COPY'").get(admin.data_owner)!.threshold,'7');
  });
  await t.test('已有账户同码仓库跳过，新仓库复制且不影响原数据',async()=>{
    const r=await shareWarehouses(admin,{requestId:randomUUID(),targetAccountId:member.id,warehouseCodes:['COPY','SKIP']},directory('member'));
    assert.deepEqual(r.skipped,['SKIP']);assert.equal(r.copied.length,1);
    assert.equal(db.prepare("SELECT name FROM warehouses WHERE owner=? AND code='SKIP'").get(member.data_owner)!.name,'接收人已有仓库');
  });
  await t.test('中途失败回滚账户与整份数据，身份凭证可重试',async()=>{
    const p=await findShareRecipient(admin,'13900000001',directory('rollback'));
    await assert.rejects(()=>shareWarehouses(admin,{requestId:randomUUID(),lookupToken:p.lookupToken,warehouseCodes:['COPY','ZZ_MISSING']},directory('rollback')),/仓库已不存在/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE dingtalk_user_id='rollback'").get()!.n,0);
    const r=await shareWarehouses(admin,{requestId:randomUUID(),lookupToken:p.lookupToken,warehouseCodes:['COPY']},directory('rollback'));assert.equal(r.copied.length,1);
  });
  await t.test('过期/跨管理员凭证、离职或串号拒绝，禁用账户不被分享启用',async()=>{
    const other=bindCompanyAccount(person('other-admin'));manageAccount(admin,other.id,{role:'admin'});const otherAdmin=accountById(other.id)!;
    const p=await findShareRecipient(admin,'13900000001',directory('blocked'));
    await assert.rejects(()=>shareWarehouses(otherAdmin,{requestId:randomUUID(),lookupToken:p.lookupToken,warehouseCodes:['COPY']},directory('blocked')),/过期/);
    await assert.rejects(()=>shareWarehouses(admin,{requestId:randomUUID(),lookupToken:p.lookupToken,warehouseCodes:['COPY']},directory('blocked',{union:'changed-person'})),/本公司/);
    const blocked=bindCompanyAccount(person('blocked'));manageAccount(admin,blocked.id,{status:'disabled'});
    await assert.rejects(()=>shareWarehouses(admin,{requestId:randomUUID(),lookupToken:p.lookupToken,warehouseCodes:['COPY']},directory('blocked')),/不可用/);assert.equal(accountById(blocked.id)!.status,'disabled');
    db.prepare('UPDATE warehouse_share_candidates SET expires_at=0').run();await assert.rejects(()=>shareWarehouses(admin,{requestId:randomUUID(),lookupToken:p.lookupToken,warehouseCodes:['COPY']},directory('blocked')),/过期/);
  });
  await t.test('手机号查询限制频率且不调用提供商',async()=>{
    for(let i=0;i<20;i++)db.prepare('INSERT INTO account_audit VALUES(?,?,?,?,?,?)').run(randomUUID(),admin.id,admin.id,'warehouse_recipient_lookup','{}',new Date().toISOString());
    const before=calls;await assert.rejects(()=>findShareRecipient(admin,'13900000001',directory()),/频繁/);assert.equal(calls,before);
  });
});
