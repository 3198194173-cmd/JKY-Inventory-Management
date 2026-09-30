import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sqlite, localDatabase } from '../lib/sqlite.mjs';
import { enqueue, enqueueDaily } from '../lib/local-jobs';
import { acquireRun, addWarehouse, loadInventory, publishSnapshot } from '../lib/inventory-store';
mkdirSync('.sites-runtime/tests',{recursive:true});
process.env.INVENTORY_DB_PATH=resolve(`.sites-runtime/tests/store-${Date.now()}.sqlite`);

test('本地数据库迁移、事务回滚、队列去重与多仓库快照隔离',async()=>{
  const db=sqlite();
  assert.equal(db.prepare('SELECT count(*) AS n FROM local_migrations').get()!.n,5);
  await addWarehouse('test-owner','TEST01','测试仓');
  const first=enqueue('test-owner','TEST01'),second=enqueue('test-owner','TEST01');
  assert.equal(first.id,second.id);
  const run=await acquireRun('test-owner','TEST01','manual',first.id);
  await assert.rejects(()=>acquireRun('test-owner','TEST01'),/正在进行/);
  await publishSnapshot('test-owner',run,[{goodsNo:'A',goodsName:'测试',unitName:'Pcs',quantity:'12345678901234567890.123',skuCount:1}],1,1,0,{key:'auto:v1',label:'测试仓',count:1},{code:'TEST01',name:'测试仓',id:'1',hash:'test'},[]);
  const view=await loadInventory('test-owner',{warehouseCode:'TEST01'});
  assert.equal(view.rows[0].quantity,'12345678901234567890.123');
  assert.equal((await loadInventory('other-owner')).totalRows,0);
  await assert.rejects(()=>localDatabase.batch([
    localDatabase.prepare("UPDATE warehouses SET name='错误' WHERE owner='test-owner' AND code='TEST01'"),
    localDatabase.prepare('INSERT INTO nonexistent_table VALUES(1)')
  ]));
  assert.equal(db.prepare("SELECT name FROM warehouses WHERE owner='test-owner' AND code='TEST01'").get()!.name,'测试仓');
});
test('08:00定时边界、重试上限与已有每日基准去重',async()=>{
  const db=sqlite();await addWarehouse('daily-owner','DAILY01','定时测试');
  const count=()=>Number(db.prepare("SELECT count(*) AS n FROM local_jobs WHERE owner='daily-owner' AND warehouse_code='DAILY01'").get()!.n);
  enqueueDaily('2030-01-01 07:59:59');assert.equal(count(),0);
  enqueueDaily('2030-01-01 08:00:00');assert.equal(count(),1);
  enqueueDaily('2030-01-01 08:01:00');assert.equal(count(),1);
  for(let i=0;i<4;i++){
    db.prepare("UPDATE local_jobs SET state='failed',updated_at='2000-01-01T00:00:00Z' WHERE owner='daily-owner' AND warehouse_code='DAILY01'").run();
    enqueueDaily('2030-01-01 08:10:00');
  }
  assert.equal(count(),3);
  const snapshot=db.prepare("SELECT id FROM stock_snapshots LIMIT 1").get()!.id;
  db.prepare("INSERT INTO daily_slots VALUES('daily-owner','DAILY01','2030-01-02',?)").run(snapshot);
  enqueueDaily('2030-01-02 08:00:00');assert.equal(count(),3);
});
