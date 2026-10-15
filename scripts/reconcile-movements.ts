import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { collectInventoryMovements, type InboundCollection } from '../lib/inbound';
import { reconcileWarehouseInbound } from '../lib/inbound-store';

// Explicit maintenance command: recompute derived sales only, never collect new
// stock snapshots, alter ERP documents, or send notifications.
const args=process.argv.slice(2);
const codeIndex=args.indexOf('--warehouse');
const code=codeIndex<0 ? '' : args[codeIndex+1];
const apply=args.includes('--apply');
if(!code || code.startsWith('--') || args.some((a,i)=>i!==codeIndex+1 && !['--warehouse','--apply'].includes(a))) {
  throw new Error('用法：node build-node/reconcile-movements.mjs --warehouse CK031 [--apply]；默认仅预览，--apply 才重算');
}
const path=resolve(process.env.INVENTORY_DB_PATH || 'storage/inventory.sqlite');
const reader=new DatabaseSync(path,{readOnly:true});
reader.exec('PRAGMA busy_timeout=10000');
const owners=reader.prepare('SELECT owner FROM warehouses WHERE code=? ORDER BY owner').all(code) as {owner:string}[];
const targets=owners.flatMap(({owner})=>{
  const latest=reader.prepare("SELECT id FROM stock_snapshots WHERE owner=? AND warehouse_code=? AND status='complete' AND coverage='auto:v1' ORDER BY captured_at DESC,id DESC LIMIT 1").get(owner,code) as {id:string}|undefined;
  return latest ? [{owner,snapshotId:latest.id}] : [];
});
const busy=reader.prepare("SELECT count(*) n FROM local_jobs WHERE warehouse_code=? AND state IN ('queued','running')").get(code) as {n:number};
reader.close();
if(!targets.length)throw new Error(`仓库 ${code} 没有可核验快照`);
console.log(`仓库 ${code}：${targets.length} 个账户；重算近30天未核验调拨出库的每日区间及最新采集区间。`);
if(!apply) {
  console.log('仅预览，未修改数据库；追加 --apply 执行。');
} else {
  if(busy.n)throw new Error('该仓库仍有采集任务，请等待任务结束再运行');
  const secret=process.env.JACKYUN_APP_SECRET;
  if(!secret)throw new Error('服务器未配置吉客云 AppSecret');
  const cache=new Map<string,InboundCollection>();
  let total=0;
  for(const [index,target] of targets.entries()) {
    const result=await reconcileWarehouseInbound(target.owner,code,process.env.JACKYUN_APP_KEY || '92058521',secret,
      async(done,windows)=>{console.log(`账户 ${index+1}/${targets.length} · 区间 ${done}/${windows}`);},
      async(key,appSecret,query,fetcher,onPage)=>{
        const identity=JSON.stringify(query);
        const previous=cache.get(identity);
        if(previous)return previous;
        const value=await collectInventoryMovements(key,appSecret,query,fetcher,onPage);
        if(cache.size>=64)cache.delete(cache.keys().next().value!);
        cache.set(identity,value);
        return value;
      },target.snapshotId);
    console.log(JSON.stringify({account:index+1,...result}));
    total+=result.checked;
    if(result.failed || result.unresolved) {
      process.exitCode=1;
      console.error('部分区间未通过核验，保留待核验状态；修复接口或单据后可重新运行。');
    }
  }
  console.log(`完成，共核算 ${total} 条商品区间；原始库存快照保持不变，未发送消息。`);
}
