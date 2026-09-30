import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
const dir = '/app/storage/backups'; mkdirSync(dir,{recursive:true});
const target = `${dir}/inventory-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`;
const db = new DatabaseSync(process.env.INVENTORY_DB_PATH || '/app/storage/inventory.sqlite');
await backup(db,target); db.close(); console.log(target);
