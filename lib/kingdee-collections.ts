import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AccessError } from './accounts';
import { addQuantity } from './decimal';
import { classifySalesRow, excludedCustomer, salesQuantity, salesSourceWorkbook, type SalesRow } from './kingdee-sales-source';
import { getXingkongCollection, insertXingkongCollection, interruptXingkongCollections, kingdeeRules, listXingkongCollections, updateXingkongCollection, xingkongCollectionDirectory } from './kingdee-store';
import { salesColumns, xingkongService, type SalesCollectionLease, type XingkongService } from './kingdee-xingkong';
import type { XingkongCollection } from './kingdee-xingkong-types';
import { classifyStockRow, stockQuantity, stockSourceColumns, stockSourceWorkbook } from './kingdee-stock-source';
type Binding = { actor: string; owner: string };
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const columns = salesColumns.map(([label,field])=>({label,field}));

export class XingkongCollections {
  private runner = randomUUID();
  private active: { id: string; owner: string; lease: SalesCollectionLease; cancelled: boolean } | null = null;
  constructor(private service: XingkongService = xingkongService(), private pageSize = 10000) { interruptXingkongCollections(this.runner); }
  list(owner: string,kind?: XingkongCollection['kind']) { return listXingkongCollections(owner,kind); }
  get(owner: string,id: string) { return getXingkongCollection(owner,id); }
  start(binding: Binding, token: string, input: unknown) {
    if (this.active) throw new AccessError(this.active.owner === binding.owner ? '当前账户已有正在运行的采集任务' : '服务器正在处理另一项采集，请稍后再试',409);
    if (this.list(binding.owner).some(job=>job.state==='running'||job.state==='cancelling')) throw new AccessError('当前账户已有正在运行的采集任务',409);
    const lease = this.service.leaseCollection(binding,token,input), now = new Date().toISOString();
    const job: XingkongCollection = { id:randomUUID(),kind:lease.kind,state:'running',createdAt:now,updatedAt:now,accountId:lease.accountId,settings:lease.settings,
      error:'',phase:lease.kind==='companySales'?'正在核验组织权限':'正在按保存方案初始化库存查询',rules:structuredClone(kingdeeRules(binding.owner)),warnings:[],
      progress:{ pages:0,rawRows:0,reportedTotal:null,businessRows:0,subtotalRows:0,grandTotalRows:0,excludedCustomerRows:0,includedRows:0,businessQuantity:'0',includedQuantity:'0',blankQuantityRows:0 } };
    try { insertXingkongCollection(binding.owner,binding.actor,this.runner,job); }
    catch (error) { lease.dispose(); throw error; }
    this.active={id:job.id,owner:binding.owner,lease,cancelled:false};
    // Standalone Node deployment: background work continues after this response and browser close.
    // A new process marks unfinished jobs interrupted; credentials and sessions are never restored.
    void (job.kind==='companyStock'?this.runStock(binding.owner,job,lease):this.run(binding.owner,job,lease)).catch(()=>{ console.error('星空采集状态保存失败，请检查金蝶业务存储。'); });
    return job;
  }
  cancel(owner: string,id: string) {
    const job = this.get(owner,id);
    if (job.state !== 'running' && job.state !== 'cancelling') throw new AccessError('该采集任务已结束',409);
    if (!this.active || this.active.id !== id || this.active.owner !== owner) throw new AccessError('当前进程没有该活动任务，请刷新后检查中断状态',409);
    this.active.cancelled=true; this.active.lease.dispose();
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
