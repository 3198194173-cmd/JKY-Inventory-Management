import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { sqlite } from '../lib/sqlite.mjs';

mkdirSync('.sites-runtime/tests',{recursive:true});
const dbPath=resolve(`.sites-runtime/tests/accounts-http-${Date.now()}.sqlite`);
process.env.INVENTORY_DB_PATH=dbPath;
const db=sqlite(),now=new Date().toISOString(),names={admin:'管理员',a:'员工甲',b:'员工乙',fresh:'新成员'};
const tokens={};
for(const [id,name] of Object.entries(names)){
  db.prepare("INSERT INTO accounts(id,data_owner,provider,corp_id,dingtalk_user_id,union_id,display_name,role,member_state,membership_checked_at,created_at,updated_at) VALUES(?,?,'dingtalk','test-corp',?,?,?,?,'verified',?,?,?)").run(id,'owner-'+id,id,'union-'+id,name,id==='admin'?'admin':'member',Date.now(),now,now);
  tokens[id]=randomBytes(32).toString('hex');db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?)').run(createHash('sha256').update(tokens[id]).digest('hex'),id,Date.now()+86400000,Date.now());
}
for(const [owner,value] of [['a','123'],['b','456']]){
  db.prepare("INSERT INTO warehouses(owner,code,name,created_at) VALUES(?,'SAME',?,?)").run('owner-'+owner,names[owner]+'仓库',now);
  db.prepare("INSERT INTO stock_snapshots(id,owner,date,captured_at,status,page_count,record_count,goods_count,totals,zero_count,negative_count,warehouse_code,coverage) VALUES(?,?,?,?,'complete',1,1,1,'{}',0,0,'SAME','auto:v1')").run('snapshot-'+owner,'owner-'+owner,'2026-10-15',now);
  db.prepare("INSERT INTO stock_entries(snapshot_id,goods_no,goods_name,unit_name,quantity,sku_count,sign) VALUES(?,'GOODS','独立库存货品','件',?,1,1)").run('snapshot-'+owner,value);
}
const reportToken=randomBytes(32).toString('base64url');
db.prepare("INSERT INTO warehouses(owner,code,name,created_at) VALUES('owner-admin','ADMIN_ONLY','管理员分享仓库',?)").run(now);
db.prepare('INSERT INTO alert_report_exports VALUES(?,?,?,?,?,?)').run(createHash('sha256').update(reportToken).digest('hex'),'owner-a','SAME',JSON.stringify({title:'test',summary:'',footer:'',dates:[],totalCount:0,part:1,totalParts:1,rows:[]}),Date.now(),Date.now()+100000);
cpSync('drizzle','.next/standalone/drizzle',{recursive:true});cpSync('public','.next/standalone/public',{recursive:true});cpSync('.next/static','.next/standalone/.next/static',{recursive:true});
const url='http://127.0.0.1:3191',origin='https://inventory.example.test';
const env={...process.env,PORT:'3191',HOSTNAME:'127.0.0.1',INVENTORY_DB_PATH:dbPath,INVENTORY_SITE_URL:origin,INVENTORY_DINGTALK_LOGIN_ENABLED:'true',INVENTORY_LOCAL_LOGIN_ENABLED:'false',DINGTALK_CORP_ID:'test-corp',DINGTALK_ADMIN_UNION_ID:'union-admin',DINGTALK_LOGIN_CLIENT_ID:'offline-app',DINGTALK_LOGIN_CLIENT_SECRET:'offline-secret',JACKYUN_APP_SECRET:'',DINGTALK_CLIENT_SECRET:'',INVENTORY_SCHEDULE_ENABLED:'false'};
let output='';const server=spawn(process.execPath,['.next/standalone/server.js'],{env,stdio:['ignore','pipe','pipe']});server.stdout.on('data',d=>output+=d);server.stderr.on('data',d=>output+=d);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const headers=(who,extra={})=>({cookie:'inventory_session='+tokens[who],origin,'Content-Type':'application/json',...extra});
async function call(path,who,body,method='POST',extra={}){return fetch(url+path,{method,headers:headers(who,extra),body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});}
try{
  for(let i=0;i<80;i++){try{if((await fetch(url+'/login')).ok)break;}catch{}await sleep(150);}
  let r=await fetch(url+'/login');assert.equal(r.status,200,output);assert.match(await r.text(),/使用公司钉钉登录/);
  r=await fetch(url+'/api/inventory?warehouseCode=SAME');assert.equal(r.status,401);
  r=await fetch(url+'/api/inventory?warehouseCode=SAME&owner=owner-a',{headers:headers('b')});assert.equal((await r.json()).rows[0].quantity,'456');
  r=await call('/api/session','b',undefined,'GET');const self=await r.json();assert.equal(self.account.id,'b');assert.equal(self.account.role,'member');assert.equal(self.workspace.id,'b');
  r=await fetch(url+'/api/inventory?warehouseCode=SAME',{headers:headers('a')});assert.equal((await r.json()).rows[0].quantity,'123');
  r=await call('/api/admin/accounts','b',undefined,'GET');assert.equal(r.status,403);
  r=await fetch(url+'/api/admin/warehouse-share');assert.equal(r.status,401);
  r=await call('/api/admin/warehouse-share','b',undefined,'GET');assert.equal(r.status,403);
  r=await call('/api/admin/warehouse-share/lookup','b',{mobile:'13900000001'});assert.equal(r.status,403);
  r=await call('/api/admin/warehouse-share','b',{warehouseCodes:['SAME']});assert.equal(r.status,403);
  r=await call('/api/admin/warehouse-share/lookup','admin',{mobile:'13900000001'},'POST',{origin:'https://evil.example'});assert.equal(r.status,400);
  r=await call('/api/admin/warehouse-share','admin',{},'POST',{origin:'https://evil.example'});assert.equal(r.status,400);
  r=await call('/api/admin/warehouse-share','admin',undefined,'GET',{cookie:'inventory_session='+tokens.admin+'; inventory_workspace=a'});assert.equal(r.status,200);assert.deepEqual((await r.json()).warehouses.map(w=>w.code),['ADMIN_ONLY']);
  r=await call('/api/admin/accounts','b',{accountId:'b',role:'admin'},'PATCH');assert.equal(r.status,403);
  r=await call('/api/workspace','b',{accountId:'a'});assert.equal(r.status,403);
  r=await call('/api/inventory?warehouseCode=SAME','b',undefined,'GET',{cookie:'inventory_session='+tokens.b+'; inventory_workspace=a'});assert.equal(r.status,403);
  r=await call('/api/warehouses','a',{code:'A2',name:'只属于甲',owner:'owner-b'});assert.equal(r.status,200);assert.ok(db.prepare("SELECT 1 FROM warehouses WHERE owner='owner-a' AND code='A2'").get());assert.equal(db.prepare("SELECT 1 FROM warehouses WHERE owner='owner-b' AND code='A2'").get(),undefined);
  r=await fetch(url+'/',{headers:headers('fresh')});assert.equal(r.status,200);assert.match(await r.text(),/选择你的第一个仓库/);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM warehouses WHERE owner='owner-fresh'").get().n,0);
  r=await fetch(url+'/api/warehouses/available');assert.equal(r.status,401);
  r=await call('/api/warehouses/available','fresh',undefined,'GET');assert.equal(r.status,400);assert.match((await r.json()).error,/AppSecret/);
  r=await call('/api/warehouses','b',{code:'CSRF'},'POST',{origin:'https://evil.example'});assert.equal(r.status,400);
  r=await fetch(url+'/api/auth/dingtalk/start',{redirect:'manual'});assert.equal(r.status,303);const auth=new URL(r.headers.get('location'));assert.equal(auth.origin,'https://login.dingtalk.com');assert.equal(auth.searchParams.get('corpId'),'test-corp');assert.match(r.headers.get('set-cookie'),/HttpOnly/i);assert.match(r.headers.get('set-cookie'),/Secure/i);assert.match(r.headers.get('set-cookie'),/SameSite=lax/i);
  r=await fetch(url+'/api/auth/dingtalk/callback?state=forged&authCode=not-real',{redirect:'manual'});assert.equal(r.status,303);assert.match(r.headers.get('location'),/login\?error=dingtalk/);assert.doesNotMatch(r.headers.get('set-cookie')||'',/inventory_session=/);
  r=await fetch(url+'/api/session',{method:'POST',headers:{origin},body:new URLSearchParams({username:'admin',password:'unused'}),redirect:'manual'});assert.equal(r.status,403);
  r=await fetch(url+'/api/alerts/reports/'+reportToken,{redirect:'manual'});assert.equal(r.status,303);
  r=await call('/api/alerts/reports/'+reportToken,'b',undefined,'GET');assert.equal(r.status,404);
  r=await call('/api/alerts/reports/'+reportToken,'a',undefined,'GET');assert.equal(r.status,200);
  r=await call('/api/alerts/reports/'+reportToken,'admin',undefined,'GET');assert.equal(r.status,200);
  r=await call('/api/admin/accounts','admin',{accountId:'admin',role:'member'},'PATCH');assert.equal(r.status,409);
  r=await call('/api/workspace','admin',{accountId:'a'});assert.equal(r.status,200);const workspaceCookie='inventory_session='+tokens.admin+'; inventory_workspace=a';
  r=await fetch(url+'/',{headers:headers('admin',{cookie:workspaceCookie})});assert.equal(r.status,200);assert.match(await r.text(),/正在管理/);
  r=await call('/api/alerts','admin',{warehouseCode:'SAME',enabled:false,threshold:'0',turnoverAverageThreshold:'18'},'POST',{cookie:workspaceCookie});assert.equal(r.status,200);assert.equal(db.prepare("SELECT turnover_average_threshold FROM warehouse_alert_settings WHERE owner='owner-a' AND warehouse_code='SAME'").get().turnover_average_threshold,'18');assert.equal(db.prepare("SELECT turnover_average_threshold FROM warehouse_alert_settings WHERE owner='owner-b' AND warehouse_code='SAME'").get().turnover_average_threshold,'3');
  assert.ok(db.prepare("SELECT 1 FROM account_audit WHERE actor_id='admin' AND target_id='a' AND action='business_write_requested'").get());
  db.prepare("INSERT INTO local_jobs(id,owner,warehouse_code,trigger,state,created_at,updated_at) VALUES('disable-queued','owner-a','SAME','manual','queued',?,?)").run(now,now);
  r=await call('/api/admin/accounts','admin',{accountId:'a',status:'disabled'},'PATCH');assert.equal(r.status,200);
  r=await call('/api/inventory?warehouseCode=SAME','a',undefined,'GET');assert.equal(r.status,401);assert.equal(db.prepare("SELECT state FROM local_jobs WHERE id='disable-queued'").get().state,'failed');
  r=await call('/api/inventory?warehouseCode=SAME','admin',undefined,'GET',{cookie:workspaceCookie});assert.equal(r.status,200);
  r=await call('/api/sync','admin',{warehouseCode:'SAME'},'POST',{cookie:workspaceCookie});assert.equal(r.status,403);
  if(process.env.ACCOUNT_BROWSER_CHECK==='true'){
    const {chromium}=await import('file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
    const browser=await chromium.launch({channel:'msedge',headless:true});
    try{
      const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:'inventory_session',value:tokens.admin,url}]);const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(url+'/admin/accounts');await page.locator('.account-member').first().waitFor();assert.equal(await page.locator('.account-member').count(),4);mkdirSync('outputs',{recursive:true});await page.screenshot({path:'outputs/account-management-desktop.png'});
      await page.getByRole('button',{name:'仓库分享',exact:true}).click();const share=page.getByRole('dialog');await share.getByText('ADMIN_ONLY · 管理员分享仓库',{exact:true}).waitFor();await page.screenshot({path:'outputs/warehouse-sharing-desktop.png'});
      await page.setViewportSize({width:390,height:844});assert.equal(await share.evaluate(e=>e.scrollWidth<=e.clientWidth),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.route('**/api/admin/warehouse-share/lookup',route=>route.fulfill({json:{lookupToken:'offline-browser-proof',name:'测试同事',userId:'offline-browser-user',maskedMobile:'139****0001',existingAccount:false}}));
      await share.getByLabel('同事的钉钉手机号').fill('+86-13900000001');await share.getByRole('button',{name:'查找同事'}).click();await share.getByText('测试同事',{exact:true}).waitFor();await share.getByRole('checkbox').check();assert.equal(await share.getByRole('button',{name:'确认复制 1 个仓库'}).isEnabled(),true);await page.screenshot({path:'outputs/warehouse-sharing-mobile.png'});
      await share.getByRole('button',{name:'取消',exact:true}).click();await page.unroute('**/api/admin/warehouse-share/lookup');
      await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'outputs/account-management-mobile.png'});
      const b=page.locator('.account-member').filter({has:page.getByRole('heading',{name:'员工乙',exact:true})});await b.getByRole('button',{name:'群授权（0）'}).click();await b.getByText('暂无企业群，请先同步企业群目录。').waitFor();await b.getByRole('button',{name:'取消',exact:true}).click();
      await page.goto(url+'/login');await page.getByRole('link',{name:'使用公司钉钉登录'}).waitFor();assert.equal(await page.locator('input[name=username]').count(),0);await page.screenshot({path:'outputs/account-login-mobile.png'});
      await context.addCookies([{name:'inventory_session',value:tokens.b,url}]);await page.goto(url+'/');await page.locator('.inventory-mobile-card').first().waitFor();assert.equal(await page.locator('.inventory-mobile-stock strong').first().innerText(),'456');assert.equal(await page.locator('.account-identity a').count(),0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'outputs/account-member-inventory-mobile.png'});
      assert.equal(await page.locator('.inventory-mobile-sort').count(),0,'手机只保留一个排序入口');
      for(const value of ['average_desc','average_asc','turnover_desc','turnover_asc']){
        const response=page.waitForResponse(r=>r.url().includes('/api/inventory?')&&new URL(r.url()).searchParams.get('sort')===value);
        await page.getByLabel('排序方式',{exact:true}).selectOption(value);assert.equal((await response).status(),200);
      }
      for(const width of [320,390,760]){
        await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        const toolbar=await page.locator('.compact-toolbar').boundingBox();assert.ok(toolbar.height<=178,'手机工具栏压缩为三行');
      }
      await page.setViewportSize({width:390,height:844});assert.ok((await page.locator('.inventory-mobile-card').first().boundingBox()).y<600,'首件商品无需先滑过整屏工具栏');await page.screenshot({path:'outputs/inventory-mobile-optimized.png'});
      await page.setViewportSize({width:1440,height:1000});await page.locator('.compact-table').waitFor();
      for(const name of ['销售均值','库存周转']){
        const button=page.getByRole('columnheader').getByRole('button',{name:new RegExp('^'+name)});
        await Promise.all([page.waitForResponse(r=>r.url().includes('/api/inventory?')&&r.ok()),button.click()]);assert.match(await button.innerText(),/↓/);
        await Promise.all([page.waitForResponse(r=>r.url().includes('/api/inventory?')&&r.ok()),button.click()]);assert.match(await button.innerText(),/↑/);
      }
      await page.screenshot({path:'outputs/inventory-desktop-sorting.png'});
      const android=await browser.newContext({viewport:{width:360,height:800},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Mobile Safari/537.36'});
      try{
        await android.addCookies([{name:'inventory_session',value:tokens.b,url}]);
        const phone=await android.newPage();phone.on('pageerror',e=>errors.push(e.message));await phone.goto(url+'/');
        // Emulate an older WebView ignoring individual CSS transforms. This must
        // still center the real modal, rather than merely testing a mobile UA.
        await phone.addStyleTag({content:'[data-slot="dialog-content"]{translate:none!important;scale:none!important;rotate:none!important}'});
        for(const width of [360,412]){
          await phone.setViewportSize({width,height:800});
          for(const name of ['在途记录','采集记录']){
            await phone.getByRole('button',{name,exact:true}).tap();const modal=phone.getByRole('dialog');await modal.waitFor();
            const box=await modal.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width+1&&box.y+box.height<=801,`${name} 必须完整留在安卓视口内`);
            assert.ok(Math.abs(box.x+box.width/2-width/2)<2,`${name} 水平居中`);
            if(width===360)await phone.screenshot({path:`outputs/android-${name==='在途记录'?'transit':'records'}-dialog.png`});
            await modal.getByRole('button',{name:'Close',exact:true}).tap();await modal.waitFor({state:'hidden'});
          }
        }
      }finally{await android.close();}
      assert.deepEqual(errors,[]);
      console.log('PASS: 账户管理与登录页面桌面/390px浏览器检查，无脚本错误及横向溢出');
    }finally{await browser.close();}
  }
  console.log('PASS: 实际 HTTP 多账户隔离、管理员权限/目标空间、导出归属、禁用会话/任务、OAuth状态/安全Cookie、关闭密码入口、CSRF和空仓库引导');
}finally{server.kill('SIGTERM');await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once('exit',resolve);});}
