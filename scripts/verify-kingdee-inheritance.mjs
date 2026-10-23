// Explicit, repeatable verification against the user's local exports. Never targets production.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, sep, basename } from 'node:path';
import { homedir } from 'node:os';
const login=JSON.parse(await readFile('.sites-runtime/platform-preview/latest.json','utf8'));
const url=new URL(login.url);
if(!login.testOnly || url.protocol!=='http:' || url.hostname!=='127.0.0.1' || !resolve(login.database).startsWith(resolve('.sites-runtime/platform-preview/current')+sep))throw new Error('仅允许本机隔离测试预览');
const auth=await fetch(url.origin+'/api/session',{method:'POST',headers:{origin:url.origin},body:new URLSearchParams({username:login.username,password:login.password}),redirect:'manual'});
assert.equal(auth.status,303);
const cookie=auth.headers.getSetCookie().find(v=>v.startsWith('inventory_session='))?.split(';')[0];assert.ok(cookie);
const headers={cookie,origin:url.origin};
const self=await(await fetch(url.origin+'/api/session',{headers})).json();assert.equal(self.account.name,'preview');
const out=resolve('.sites-runtime/verification/inheritance-20261023');await mkdir(out,{recursive:true});
async function submit(form){const r=await fetch(url.origin+'/api/kingdee/imports',{method:'POST',headers,body:form});const b=await r.json();if(!r.ok)throw new Error(b.error);return b.batch;}
const master=resolve('../资料/金蝶/目标模板/casebang 存销明细 2026.10.09.xlsx');
const form=new FormData();form.append('legacy',new File([await readFile(master)],basename(master)));form.append('inheritance',JSON.stringify({baselineOnly:true}));
const base=await submit(form);assert.equal(base.summary.goods,40578);assert.deepEqual(base.template.periods,[]);
await writeFile(resolve(out,'baseline.json'),JSON.stringify(base));
console.log(JSON.stringify({baseline:base.id,originalRows:base.summary.goods}));
const downloads=resolve(homedir(),'Downloads');
const sources={companySales:resolve(downloads,'xingkong-eb197e80-ef18-4ee8-b8f2-6f8060ee97ae-source.xlsx'),companyStock:resolve(downloads,'xingkong-4361322d-ab67-4bfc-bdc9-60e443c8fbc6-source.xlsx'),storeSales:resolve(downloads,'销售明细表-20261023091103.xlsx'),storeStock:resolve(downloads,'库存查询表-20261023091202.xlsx'),prices:resolve('../资料/金蝶/原始导出/2026-10-19/销售价目表_2026101917162424_140068.xlsx')};
const data=new FormData();for(const [kind,path] of Object.entries(sources))data.append(kind,new File([await readFile(path)],basename(path)));
data.append('inheritance',JSON.stringify({baseBatchId:base.id,period:{start:'2026-10-01',end:'2026-10-31',stockDate:'2026-10-23'}}));
const batch=await submit(data);assert.ok(batch.summary.goods>=40578);assert.equal(batch.template.periods.length,1);
await writeFile(resolve(out,'batch.json'),JSON.stringify(batch));
const view=await(await fetch(url.origin+'/api/kingdee?batch='+batch.id+'&pageSize=100',{headers})).json();assert.equal(view.rows[0].sheetRow,2);assert.equal(view.coverage.legacy,40578);
const excel=await fetch(url.origin+'/api/kingdee/export?batch='+batch.id,{headers});assert.equal(excel.status,200);await writeFile(resolve(out,'inherited.xlsx'),Buffer.from(await excel.arrayBuffer()));
console.log(JSON.stringify({batch:batch.id,goods:batch.summary.goods,newCodes:batch.summary.goods-40578,totals:batch.summary.totals,export:resolve(out,'inherited.xlsx')}));
