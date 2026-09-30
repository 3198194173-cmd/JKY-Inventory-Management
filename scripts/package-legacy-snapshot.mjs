import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] || '.sites-runtime');
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const prefix = manifest.filePrefix;
if (typeof prefix !== 'string' || !/^[a-z0-9-]+$/.test(prefix)) throw new Error('清单前缀无效');
const files = readdirSync(dir).filter(name => name.startsWith(prefix) && /^.*-\d{2}\.json$/.test(name)).sort();
const rows = files.flatMap(name => {
  const part = JSON.parse(readFileSync(join(dir, name), 'utf8'));
  if (!Array.isArray(part)) throw new Error(`${name} 不是数组`);
  return part;
});
if (rows.length !== manifest.expectedEntries) throw new Error(`历史清单不完整：预期 ${manifest.expectedEntries}，实际 ${rows.length}`);
const target = join(dir, `${prefix}.bundle.json`);
writeFileSync(target, JSON.stringify({ manifest, rows }));
console.log(`已生成私有迁移包：${target}，${rows.length} 行。此文件已被 Git 忽略，不要提交或公开。`);
