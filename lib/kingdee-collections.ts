import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AccessError } from './accounts';
import { addQuantity } from './decimal';
import { classifySalesRow, excludedCustomer, salesQuantity, salesSourceWorkbook, type SalesRow } from './kingdee-sales-source';
import { getXingkongCollection, insertXingkongCollection, interruptXingkongCollections, kingdeeRules, listXingkongCollections, updateXingkongCollection, xingkongCollectionDirectory, listCollectionRuns, saveCollectionRun } from './kingdee-store';
import { readXingkongSettings, salesColumns, xingkongService, type SalesCollectionLease, type XingkongService } from './kingdee-xingkong';
import type { CollectionKind, CollectionRun, XingkongCollection } from './kingdee-xingkong-types';
import { classifyStockRow, stockQuantity, stockSourceColumns, stockSourceWorkbook } from './kingdee-stock-source';
import { fetchGoodsPage, flatSourceWorkbook, type GoodsRecord } from './kingdee-goods-source';
import { priceSourceWorkbook, readPriceSchema, type PriceRow } from './kingdee-price-source';
type Binding = { actor: string; owner: string };
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const columns = salesColumns.map(([label,field])=>({label,field}));

export class XingkongCollections {
  private runner = randomUUID();
  private active: { id: string; owner: string; lease: Pick<SalesCollectionLease,'dispose'|'signal'|'cancel'>; cancelled: boolean } | null = null;
  private task: Promise<void> | null = null;
  private pipeline: { owner:string; run:CollectionRun } | null = null;
  constructor(private service: XingkongService = xingkongService(), private pageSize = 10000, private goodsFetcher = fetchGoodsPage) { interruptXingkongCollections(this.runner); }
  list(owner: string,kind?: XingkongCollection['kind']) { return listXingkongCollections(owner,kind); }
  get(owner: string,id: string) { return getXingkongCollection(owner,id); }
  start(binding: Binding, token: string, input: unknown, runId?:string) {
    if(this.pipeline&&this.pipeline.run.id!==runId)throw new AccessError('统一采集正在执行，请等待完成',409);
    if (this.active) throw new AccessError(this.active.owner === binding.owner ? '当前账户已有正在运行的采集任务' : '服务器正在处理另一项采集，请稍后再试',409);
    if (this.list(binding.owner).some(job=>job.state==='running'||job.state==='cancelling')) throw new AccessError('当前账户已有正在运行的采集任务',409);
    const lease = this.service.leaseCollection(binding,token,input,!!runId), now = new Date().toISOString();
    const job: XingkongCollection = { id:randomUUID(),kind:lease.kind,state:'running',createdAt:now,updatedAt:now,accountId:lease.accountId,settings:lease.settings,
      ...(runId?{runId}:{}),error:'',phase:'正在初始化采集与校验条件',rules:structuredClone(kingdeeRules(binding.owner)),warnings:[],
      progress:{ pages:0,rawRows:0,reportedTotal:null,businessRows:0,subtotalRows:0,grandTotalRows:0,excludedCustomerRows:0,includedRows:0,businessQuantity:'0',includedQuantity:'0',blankQuantityRows:0 } };
    try { insertXingkongCollection(binding.owner,binding.actor,this.runner,job); }
    catch (error) { lease.dispose(); throw error; }
    this.active={id:job.id,owner:binding.owner,lease,cancelled:false};
    // Standalone Node deployment: background work continues after this response and browser close.
    // A new process marks unfinished jobs interrupted; credentials and sessions are never restored.
    this.task=(job.kind==='prices'?this.runPrices(binding.owner,job,lease):job.kind==='companyStock'?this.runStock(binding.owner,job,lease):this.run(binding.owner,job,lease));
    void this.task.catch(()=>{ console.error('采集状态保存失败，请检查金蝶业务存储。'); });
    return job;
  }
  runs(owner:string){return listCollectionRuns(owner);}
  startRun(binding:Binding,token:string,input:unknown){
    if(this.pipeline||this.active)throw new AccessError('已有采集正在执行',409);
    if(!input||typeof input!=='object'||Array.isArray(input))throw new AccessError('统一采集参数无效',400);
    const data=input as Record<string,unknown>,kinds=data.kinds;
    if(!Array.isArray(kinds)||!kinds.length||new Set(kinds).size!==kinds.length||kinds.some(kind=>!['companySales','companyStock','prices','goods'].includes(String(kind))))throw new AccessError('请选择有效采集模块',400);
    const settings=Object.fromEntries(Object.entries(data).filter(([key])=>key!=='kinds'));
    for(const kind of kinds)if(kind!=='goods')readXingkongSettings({...settings,kind});
    const now=new Date().toISOString(),run:CollectionRun={id:randomUUID(),createdAt:now,updatedAt:now,state:'running',phase:'准备开始统一采集',error:'',kinds:kinds as CollectionKind[],collections:{}};
    saveCollectionRun(binding.owner,this.runner,run);this.pipeline={owner:binding.owner,run};
    void this.executeRun(binding,token,settings,run).catch(()=>console.error('统一采集状态保存失败'));return run;
  }
  cancelRun(owner:string,id:string){
    if(!this.pipeline||this.pipeline.owner!==owner||this.pipeline.run.id!==id)throw new AccessError('当前账户没有该活动统一采集',404);
    this.pipeline.run.cancelRequested=true;
    if(this.active?.owner===owner)this.cancel(owner,this.active.id);
    saveCollectionRun(owner,this.runner,this.pipeline.run);return this.pipeline.run;
  }
  private async executeRun(binding:Binding,token:string,settings:Record<string,unknown>,run:CollectionRun){
    const errors:string[]=[];
    try{
      // Browser only starts/polls the run; all sequencing lives on the server.
      for(const kind of run.kinds){
        if(run.cancelRequested)break;
        run.phase=`正在采集${{companySales:'公司销量',companyStock:'公司库存',prices:'结算价',goods:'停止采购'}[kind]}`;saveCollectionRun(binding.owner,this.runner,run);
        try{
          const job=kind==='goods'?this.startGoods(binding,run.id):this.start(binding,token,{...settings,kind},run.id);
          run.collections[kind]=job.id;saveCollectionRun(binding.owner,this.runner,run);
          await this.task;
          const done=this.get(binding.owner,job.id);if(done.state!=='ready')errors.push(`${kind}：${done.error||done.phase}`);
        }catch(error){errors.push(`${kind}：${error instanceof Error?error.message:'启动失败'}`);}
      }
      run.state=run.cancelRequested?'cancelled':errors.length?'failed':'ready';
      run.phase=run.state==='ready'?'所选模块全部完成，可采用本次来源':run.state==='cancelled'?'统一采集已停止':'部分模块失败，已完成来源保留';run.error=errors.join('；').slice(0,1500);
    }catch{run.state='failed';run.phase='统一采集失败';run.error='任务状态处理失败，请检查记录';}
    finally{try{if(token)this.service.disconnect(binding,token);}catch{}try{saveCollectionRun(binding.owner,this.runner,run);}finally{this.pipeline=null;}}
  }
  startGoods(binding:Binding,runId?:string){
    if(this.active||(this.pipeline&&this.pipeline.run.id!==runId))throw new AccessError('已有采集正在执行',409);
    const appkey=process.env.JACKYUN_APP_KEY||'',secret=process.env.JACKYUN_APP_SECRET||'';
    if(!appkey||!secret)throw new AccessError('服务器未配置吉客云采集应用',422);
    const now=new Date().toISOString(),abort=new AbortController(),timer=setTimeout(()=>abort.abort(),45*60000);timer.unref();
    const job:XingkongCollection={id:randomUUID(),kind:'goods',...(runId?{runId}:{}),state:'running',createdAt:now,updatedAt:now,accountId:'吉客云服务端应用',settings:{start:'',end:'',salesOrganization:'',settleOrganization:'',schemeId:''},rules:structuredClone(kingdeeRules(binding.owner)),error:'',phase:'正在读取货品停止采购状态',warnings:[],progress:{pages:0,rawRows:0,reportedTotal:null,businessRows:0,subtotalRows:0,grandTotalRows:0,excludedCustomerRows:0,includedRows:0,businessQuantity:'0',includedQuantity:'0',blankQuantityRows:0}};
    const lease={signal:abort.signal,dispose:()=>{clearTimeout(timer);abort.abort();}};
    try{insertXingkongCollection(binding.owner,binding.actor,this.runner,job);}catch(error){lease.dispose();throw error;}
    this.active={id:job.id,owner:binding.owner,lease,cancelled:false};this.task=this.runGoods(binding.owner,job,appkey,secret,lease);void this.task.catch(()=>console.error('货品采集状态保存失败'));return job;
  }
  private async runGoods(owner:string,job:XingkongCollection,appkey:string,secret:string,lease:Pick<SalesCollectionLease,'signal'|'dispose'>){
    const directory=xingkongCollectionDirectory(owner,job.id),rows:GoodsRecord[]=[],seen=new Set<string>();let cursor='0',complete=false;
    try{
      await mkdir(directory,{recursive:true});
      for(let page=1;page<=5000;page++){
        check(!lease.signal.aborted,'货品采集已停止');const result=await this.goodsFetcher(appkey,secret,cursor,lease.signal);
        if(page===1)job.progress.reportedTotal=result.total;
        await writeFile(join(directory,`page-${String(page).padStart(4,'0')}.json`),JSON.stringify({cursor,...result}),{flag:'wx'});
        job.progress.pages=page;
        if(!result.rows.length){complete=true;break;}
        const next=result.rows.at(-1)!.skuId;
        for(const row of result.rows){check(BigInt(row.skuId)>BigInt(cursor)&&BigInt(row.skuId)<=BigInt(next)&&!seen.has(row.skuId),'货品分页规格内码重复或游标未递增');seen.add(row.skuId);rows.push(row);}
        check(rows.length<=149999,'货品超过149999规格处理上限，未发布');cursor=next;
        job.progress.rawRows=rows.length;job.progress.businessRows=rows.length;job.progress.includedRows=rows.length;job.phase=`货品第${page}页，已读取${rows.length}条`;updateXingkongCollection(owner,job);
        await new Promise<void>(accept=>setTimeout(accept,200));
      }
      check(complete&&!lease.signal.aborted,'货品尚未完整采集');
      check(job.progress.reportedTotal===null||rows.length===job.progress.reportedTotal,'货品实收数与首批总数不符，未发布');
      const content=flatSourceWorkbook(['物料编码','物料名称','停止采购','规格内码'],rows.map(row=>[row.goodsNo,row.goodsName,row.stopPurchasing,row.skuId]),'吉客云货品属性');
      await this.publishSource(owner,job,content,`吉客云货品属性-${job.createdAt.slice(0,10)}.xlsx`,{method:'erp.storage.goodslist',rows:rows.length,unknown:rows.filter(row=>row.stopPurchasing===null).length});
      job.warnings=['只按goodsNo精确关联物料编码，不从名称猜测；未返回或冲突保留未知，不当作否。','停止采购直接使用isStopPurchasing，不转换POD，不改写类目、型号或IP。'];
      job.state='ready';job.phase='货品停止采购采集完成';updateXingkongCollection(owner,job);
    }catch(error){this.fail(owner,job,error);}finally{lease.dispose();if(this.active?.id===job.id)this.active=null;}
  }
  private async runPrices(owner:string,job:XingkongCollection,lease:SalesCollectionLease){
    const rows:PriceRow[]=[],seen=new Set<string>(),directory=xingkongCollectionDirectory(owner,job.id);let complete=false;
    try{
      await mkdir(directory,{recursive:true});await lease.prepare();
      for(let page=1;page<=500;page++){
        check(!lease.signal.aborted,'价目表采集已停止');const result=await lease.page(rows.length,2000);
        await writeFile(join(directory,`page-${String(page).padStart(4,'0')}.json`),JSON.stringify(result),{flag:'wx'});
        job.progress.pages=page;if(!result.rows.length){complete=true;break;}
        for(const row of result.rows as unknown as PriceRow[]){const key=row.id+'\0'+row.entryId;check(!seen.has(key),'价目表出现重复分录内码，未发布');seen.add(key);rows.push(row);}
        check(rows.length<=149999,'价目表超过149999分录处理上限，未发布');job.progress.rawRows=rows.length;job.progress.businessRows=rows.length;job.progress.includedRows=rows.length;job.phase=`价目表第${page}页，已读取${rows.length}条`;updateXingkongCollection(owner,job);
      }
      check(complete&&!lease.signal.aborted,'价目表尚未完整采集');job.progress.reportedTotal=rows.length;
      await this.publishSource(owner,job,priceSourceWorkbook(rows,readPriceSchema()),`星空销售价目表-${job.settings.priceListNumber}.xlsx`,{rows:rows.length,formId:'BD_SAL_PriceList',settings:job.settings});
      job.warnings=['按组织、价目表编号查询；状态、整单状态、失效均为全部，单位和有效期原值保留。','同编码价格或单位/有效期冲突留空，不任取第一条；价格生效口径尚需业务确认。','稳定内码排序并检查重复分录；分页并非原子快照，采集期间请避免修改价目表。'];job.state='ready';job.phase='销售价目表采集完成';updateXingkongCollection(owner,job);
    }catch(error){this.fail(owner,job,error);}finally{lease.dispose();if(this.active?.id===job.id)this.active=null;}
  }
  private async publishSource(owner:string,job:XingkongCollection,content:Buffer,name:string,audit:unknown){
    check(content.length<=32*1024*1024,'来源超过32MB，未发布');const directory=xingkongCollectionDirectory(owner,job.id);
    await writeFile(join(directory,'source.xlsx'),content,{flag:'wx'});await writeFile(join(directory,'audit.json'),JSON.stringify(audit));await writeFile(join(directory,'statistics.json'),JSON.stringify(audit));job.source={name,size:content.length,sha256:hash(content),rows:job.progress.businessRows};
  }
  private fail(owner:string,job:XingkongCollection,error:unknown){const cancelled=this.active?.id===job.id&&this.active.cancelled;job.state=cancelled?'cancelled':'failed';job.phase=cancelled?'采集已停止':'采集失败，未发布完整来源';job.error=error instanceof Error?error.message.slice(0,500):'采集失败';delete job.source;updateXingkongCollection(owner,job);}
  cancel(owner: string,id: string) {
    const job = this.get(owner,id);
    if (job.state !== 'running' && job.state !== 'cancelling') throw new AccessError('该采集任务已结束',409);
    if (!this.active || this.active.id !== id || this.active.owner !== owner) throw new AccessError('当前进程没有该活动任务，请刷新后检查中断状态',409);
    this.active.cancelled=true; (this.active.lease.cancel ?? this.active.lease.dispose)();
    job.state='cancelling';job.phase='正在停止，未发布的结果不会用于统计';updateXingkongCollection(owner,job);return job;
  }
  private async run(owner: string,job: XingkongCollection,lease: SalesCollectionLease) {
    const business: SalesRow[] = [], seen = new Set<string>(), pageHashes: {page:number;sha256:string;rows:number}[] = [];
    const totals: {code:string;name:string;quantity:string;units:string[]}[] = [];
    const byCode = new Map<string,typeof totals[number]>();
    let receivedBytes=0, complete=false, trailingTotal=false;
    const directory = xingkongCollectionDirectory(owner,job.id);
    try {
      await mkdir(directory,{recursive:true}); await lease.prepare();
      for (let page=1; page<=1000;page++) {
        check(!lease.signal.aborted,'采集已停止或超过45分钟');
        job.phase=`正在查询第${page}页，每页最多${this.pageSize}条原始报表行`;updateXingkongCollection(owner,job);
        const result = await lease.page(job.progress.rawRows,this.pageSize);
        const raw = JSON.stringify(result.rows); receivedBytes += Buffer.byteLength(raw);
        check(receivedBytes <= 96*1024*1024,'原始报表超过本次96MB处理上限，请缩小日期范围');
        // Save the actual page even if a later completeness check rejects the run.
        await writeFile(join(directory,`page-${String(page).padStart(4,'0')}.json`),JSON.stringify({page,request:result.request,total:result.total,rows:result.rows}),{flag:'wx'});
        check(result.total <= 100000,'报表超过本次10万原始行上限，请缩小日期范围');
        if (job.progress.reportedTotal === null) job.progress.reportedTotal=result.total;
        check(job.progress.reportedTotal === result.total,'分页期间RowCount发生变化，停止发布，不能拼接不同范围的结果');
        const end = job.progress.rawRows + result.rows.length;
        const standaloneTotal = (row: SalesRow) => classifySalesRow(row)==='grandTotal' && !row.FMATERIALNUMBER && !row.FCUSTOMERNUMBER && !row.FCUSTOMERNAME && ['FSALEORGNAME','FSETTLEORGNAME'].some(field=>['合计','总计'].includes(String(row[field])));
        const extra = end === result.total+1 && !!result.rows.length && standaloneTotal(result.rows.at(-1)!);
        check(result.rows.length <= this.pageSize || extra && result.rows.length === this.pageSize+1,'接口超过本页请求行数，停止发布');
        check(end <= result.total || extra,'实收行数超过RowCount且不是唯一末尾独立总计');
        if (result.rows.length) { const fingerprint=hash(raw);check(!seen.has(fingerprint),'接口返回完全重复页，停止发布，不做按物料去重');seen.add(fingerprint);pageHashes.push({page,sha256:fingerprint,rows:result.rows.length}); }
        for (const row of result.rows) {
          const kind = classifySalesRow(row);
          if (kind !== 'business') { if (kind === 'subtotal') job.progress.subtotalRows++;else job.progress.grandTotalRows++;continue; }
          check(typeof row.FMATERIALNUMBER==='string' && !!row.FMATERIALNUMBER.trim() && typeof row.FCUSTOMERNUMBER==='string' && !!row.FCUSTOMERNUMBER.trim() && typeof row.FCUSTOMERNAME==='string' && !!row.FCUSTOMERNAME.trim(),'业务行缺少物料或客户编码/名称，不能作为小计静默丢弃');
          check(String(row.FSALEORGNAME).toUpperCase()===result.organizations[0].name.toUpperCase() && String(row.FSETTLEORGNAME).toUpperCase()===result.organizations[1].name.toUpperCase(),'返回业务行组织与请求不一致，停止发布');
          const quantity = salesQuantity(row.FOUTSTOCKQTY); if (row.FOUTSTOCKQTY==null || row.FOUTSTOCKQTY==='') job.progress.blankQuantityRows++;
          job.progress.businessRows++;job.progress.businessQuantity=addQuantity(job.progress.businessQuantity,quantity);business.push(row);
          check(business.length<=50000,'业务行超过本次5万行处理上限，请缩小日期范围');
          if (excludedCustomer(row,job.rules.companySales.excludeCustomerContains)) { job.progress.excludedCustomerRows++;continue; }
          job.progress.includedRows++;job.progress.includedQuantity=addQuantity(job.progress.includedQuantity,quantity);
          const code=String(row.FMATERIALNUMBER), item: (typeof totals)[number]=byCode.get(code)||{code,name:String(row.FMATERIALNAME||''),quantity:'0',units:[]};
          item.quantity=addQuantity(item.quantity,quantity);const unit=String(row.FUNITNAME||'');if(!item.units.includes(unit))item.units.push(unit);byCode.set(code,item);
        }
        job.progress.pages=page;job.progress.rawRows=end;trailingTotal=extra;
        updateXingkongCollection(owner,job);
        if (end===result.total || extra) { complete=true;break; }
        check(result.rows.length>0,'未取齐就返回空页，停止发布');
        await new Promise<void>(accept=>setTimeout(accept,500));
      }
      check(complete,'达到分页上限，尚未完整采集');check(!lease.signal.aborted,'采集已停止，未发布完整来源');
      check(job.progress.businessRows+job.progress.subtotalRows+job.progress.grandTotalRows===job.progress.rawRows,'原始行分类计数不一致');
      check(job.progress.includedRows+job.progress.excludedCustomerRows===job.progress.businessRows,'客户排除计数不一致');
      job.phase='分页已取齐，正在生成完整来源与正式统计';updateXingkongCollection(owner,job);
      const conditions = `星空API完整分页；销售组织${job.settings.salesOrganization}，结算组织${job.settings.settleOrganization}；${job.settings.start}至${job.settings.end}；账套${job.accountId}；采集任务${job.id}；保留${job.progress.businessRows}行业务原件，剔除显示小计/总计。源合计由业务行计算，非独立ERP控制合计；客户排除在生成明细时按所选规则执行。`;
      const content=salesSourceWorkbook(business,columns,conditions);
      check(content.length<=32*1024*1024,'采集来源超过32MB，未发布，请缩小日期范围');
      await writeFile(join(directory,'source.xlsx'),content,{flag:'wx'});
      totals.push(...byCode.values());totals.sort((a,b)=>a.code.localeCompare(b.code,'en'));
      await writeFile(join(directory,'statistics.json'),JSON.stringify(totals),{flag:'wx'});
      await writeFile(join(directory,'audit.json'),JSON.stringify({job:job.id,accountId:job.accountId,settings:job.settings,rules:job.rules,progress:job.progress,pageHashes,trailingTotalOutsideRowCount:trailingTotal,apiReadComplete:true,uiEquivalentVerified:false,sourceSha256:hash(content)}),{flag:'wx'});
      check(!lease.signal.aborted,'采集已停止，未发布完整来源');
      job.source={name:`星空销售完整业务来源_${job.settings.start}_${job.settings.end}.xlsx`,size:content.length,sha256:hash(content),rows:business.length};
      job.warnings=['已按RowCount读取全部原始行并剔除显示小计/总计；不对业务行按物料编码去重。',`正式销量按规则v${job.rules.version}排除${job.progress.excludedCustomerRows}行业务记录，赠品和负数保留。`,'源文件保留客户排除前全部业务行，便于后续规则重算；来源合计为程序计算，仍需同条件Excel独立核对。','销售接口没有仓库字段，六项排除是客户名称条件，不作用于库存仓库。','分页不是原子快照，RowCount稳定不证明数据在采集期间没有变化。'];
      if (job.progress.blankQuantityRows)job.warnings.push(`${job.progress.blankQuantityRows}行业务出库数量为空，按现有汇总规则不增加数量，原空值保留。`);
      if (!business.length)job.warnings.push('本次完整查询未返回业务行，不能据此认定其他日期或组织无数据。');
      if(totals.some(item=>item.units.length>1))job.warnings.push('部分物料出现多个单位，按原始出库数量参考汇总，单位换算仍待核验。');
      job.state='ready';job.phase='正式销售统计完成，可用于生成明细';updateXingkongCollection(owner,job);
    } catch (error) {
      const cancelled = this.active?.id===job.id && this.active.cancelled;
      job.state=cancelled?'cancelled':'failed';job.phase=cancelled?'采集已停止，未发布完整来源':'采集失败，未发布完整来源';
      job.error=cancelled?'已保存页保留；重新采集需重新登录。':error instanceof Error?error.message.slice(0,400):'采集失败';delete job.source;
      updateXingkongCollection(owner,job);
    } finally { lease.dispose();if(this.active?.id===job.id)this.active=null; }
  }
  private async runStock(owner: string,job: XingkongCollection,lease: SalesCollectionLease) {
    const directory=xingkongCollectionDirectory(owner,job.id),pageSize=Math.min(this.pageSize,1000);
    const business:SalesRow[]=[],seen=new Set<string>(),pageHashes:{page:number;sha256:string;rows:number}[]=[];
    const assignments=new Map(job.rules.warehouses.members.map(member=>[member.name,member.group]));
    const warehouses=new Map<string,NonNullable<XingkongCollection['stock']>['warehouses'][number]>();
    const materials=new Map<string,{code:string;name:string;inner:string;outer:string;quantity:string;units:string[]}>();
    job.stock={inner:'0',outer:'0',excludedQuantity:'0',excludedRows:0,queryIdReused:false,quantityField:'FSTOCKJCQTY',warehouses:[]};
    let bytes=0,complete=false;
    try {
      await mkdir(directory,{recursive:true});await lease.prepare();
      for(let page=1;page<=1000;page++){
        check(!lease.signal.aborted,'采集已停止或超过45分钟');
        job.phase=`正在读取库存第${page}页，每页最多${pageSize}行`;updateXingkongCollection(owner,job);
        const result=await lease.page(job.progress.rawRows,pageSize),raw=JSON.stringify(result.rows);
        bytes+=Buffer.byteLength(raw);check(bytes<=192*1024*1024,'库存原始数据超过192MB处理上限，请调整保存方案后重采');
        await writeFile(join(directory,`page-${String(page).padStart(4,'0')}.json`),JSON.stringify({page,request:result.request,total:result.total,rows:result.rows}),{flag:'wx'});
        check(result.total<=100000,'库存超过10万原始行处理上限，请调整保存方案后重采');
        if(job.progress.reportedTotal===null)job.progress.reportedTotal=result.total;
        check(job.progress.reportedTotal===result.total,'库存TotalCount发生变化，停止发布');
        check(result.rows.length<=pageSize&&job.progress.rawRows+result.rows.length<=result.total,'库存实际行数超过Limit或TotalCount，停止发布');
        if(result.rows.length){const fingerprint=hash(raw);check(!seen.has(fingerprint),'库存接口返回完全重复页，停止发布，不按物料去重');seen.add(fingerprint);pageHashes.push({page,sha256:fingerprint,rows:result.rows.length});}
        for(const row of result.rows){
          const type=classifyStockRow(row);if(type!=='business'){if(type==='subtotal')job.progress.subtotalRows++;else job.progress.grandTotalRows++;continue;}
          const value=(key:string)=>typeof row[key]==='string'?String(row[key]).trim():'';
          check(!!value('FMATERIALNUMBER')&&!!value('FSTOCKNUMBER')&&!!value('FSTOCKNAME')&&!!value('FSTOCKUNITNAME'),'库存业务行缺少物料编码、仓库编码/名称或库存单位，停止发布');
          const quantity=stockQuantity(row.FSTOCKJCQTY),code=value('FMATERIALNUMBER'),stockCode=value('FSTOCKNUMBER'),stockName=value('FSTOCKNAME');
          job.progress.businessRows++;job.progress.businessQuantity=addQuantity(job.progress.businessQuantity,quantity);
          business.push(Object.fromEntries(stockSourceColumns.map(([,field])=>[field,row[field]??null])));
          const group=assignments.get(stockName)||'outside',key=JSON.stringify([stockCode,stockName]);
          const warehouse=warehouses.get(key)||{code:stockCode,name:stockName,quantity:'0',rows:0,group};
          warehouse.quantity=addQuantity(warehouse.quantity,quantity);warehouse.rows++;warehouses.set(key,warehouse);
          if(group!=='inner'&&group!=='outer'){job.stock.excludedRows++;job.stock.excludedQuantity=addQuantity(job.stock.excludedQuantity,quantity);continue;}
          job.progress.includedRows++;job.progress.includedQuantity=addQuantity(job.progress.includedQuantity,quantity);job.stock[group]=addQuantity(job.stock[group],quantity);
          const material=materials.get(code)||{code,name:value('FMATERIALNAME'),inner:'0',outer:'0',quantity:'0',units:[]};
          material[group]=addQuantity(material[group],quantity);material.quantity=addQuantity(material.quantity,quantity);
          const unit=value('FSTOCKUNITNAME');if(!material.units.includes(unit))material.units.push(unit);materials.set(code,material);
        }
        job.progress.pages=page;job.progress.rawRows+=result.rows.length;job.stock.queryIdReused=page>1;job.stock.warehouses=[...warehouses.values()];updateXingkongCollection(owner,job);
        if(job.progress.rawRows===result.total){complete=true;break;}
        check(result.rows.length>0,'库存未取齐就返回空页，停止发布');await new Promise<void>(accept=>setTimeout(accept,500));
      }
      check(complete,'达到分页上限，库存尚未取齐');check(!lease.signal.aborted,'采集已停止，未发布完整库存');
      check(job.progress.businessRows+job.progress.subtotalRows+job.progress.grandTotalRows===job.progress.rawRows,'库存原始行分类计数不一致');
      check(job.progress.includedRows+job.stock.excludedRows===job.progress.businessRows,'仓库归组计数不一致');
      check(addQuantity(job.stock.inner,job.stock.outer)===job.progress.includedQuantity,'内外仓结存合计不一致');
      job.phase='库存分页已取齐，正在生成完整来源';updateXingkongCollection(owner,job);
      const conditions=`星空库存API完整分页；账套${job.accountId}；方案${job.settings.schemeId}；采集任务${job.id}；实际日期、组织、仓库范围取自星空保存方案，网页预期${job.settings.start}至${job.settings.end}未作为条件发送。保存全部返回仓库业务行，生成明细时按当前内外仓名单计算FSTOCKJCQTY；源合计由程序计算，非独立ERP控制合计。`;
      const content=stockSourceWorkbook(business,conditions);check(content.length<=32*1024*1024,'库存完整来源超过32MB，未发布');
      await writeFile(join(directory,'source.xlsx'),content,{flag:'wx'});
      await writeFile(join(directory,'statistics.json'),JSON.stringify([...materials.values()].sort((a,b)=>a.code.localeCompare(b.code,'en'))),{flag:'wx'});
      await writeFile(join(directory,'audit.json'),JSON.stringify({job:job.id,kind:job.kind,accountId:job.accountId,settings:job.settings,rules:job.rules,progress:job.progress,stock:job.stock,pageHashes,apiReadComplete:true,schemeConditionsVerified:false,uiEquivalentVerified:false,sourceSha256:hash(content)}),{flag:'wx'});
      check(!lease.signal.aborted,'采集已停止，未发布完整库存');
      job.source={name:`星空库存完整业务来源_${job.id.slice(0,8)}.xlsx`,size:content.length,sha256:hash(content),rows:business.length};
      job.warnings=['已按TotalCount取齐保存方案返回范围，翻页复用同一CurQueryId；查询标识不落库。','实际日期、组织和仓库范围由星空保存方案决定；未确认方案为全部仓库，不将网页预期日期当作已生效条件。',`按启动时规则v${job.rules.version}统计内外仓；名单外及明确排除仓库共${job.stock.excludedRows}行业务记录，原件全部保留。`,'使用结存数量FSTOCKJCQTY，保留0与负数；不把发出数量当销量，不使用参考价替代结算价。','源合计由程序计算，仍需与同条件Excel独立核对；生成明细时按当前仓库规则重算。'];
      const absent=job.rules.warehouses.members.filter(member=>member.group!=='excluded'&&![...warehouses.values()].some(item=>item.name===member.name));
      if(absent.length)job.warnings.push(`当前方案返回中未出现的名单仓库：${absent.map(member=>member.name).join('、')}；未出现不证明库存为0。`);
      if([...materials.values()].some(item=>item.units.length>1))job.warnings.push('部分物料涉及多个库存单位，当前按原始数量参考汇总，单位换算待核验。');
      job.state='ready';job.phase='公司库存采集完成，可用于生成明细';updateXingkongCollection(owner,job);
    }catch(error){
      const cancelled=this.active?.id===job.id&&this.active.cancelled;job.state=cancelled?'cancelled':'failed';job.phase=cancelled?'库存采集已停止':'库存采集失败，未发布完整来源';
      job.error=cancelled?'已保存页保留，重新采集需再次登录。':error instanceof Error?error.message.slice(0,400):'库存采集失败';delete job.source;updateXingkongCollection(owner,job);
    }finally{lease.dispose();if(this.active?.id===job.id)this.active=null;}
  }
  async download(owner: string,id: string,format: string) {
    const job=this.get(owner,id);if(job.state!=='ready'||!job.source)throw new AccessError('该任务尚无完整可下载结果',409);
    const file=format==='source'?'source.xlsx':format==='audit'?'audit.json':format==='statistics'?'statistics.json':null;
    if(!file)throw new AccessError('下载类型无效',400);
    const bytes=await readFile(join(xingkongCollectionDirectory(owner,id),file));
    if(format==='source'&&(bytes.length!==job.source.size||hash(bytes)!==job.source.sha256))throw new AccessError('完整来源校验失败',409);
    return {job,bytes,file};
  }
}
const key=Symbol.for('casebang.kingdee.collections');
const processState=globalThis as typeof globalThis & {[key]?:XingkongCollections};
export function xingkongCollections(){return processState[key] ||= new XingkongCollections();}
