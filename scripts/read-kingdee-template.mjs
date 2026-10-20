// Read-only extraction of column/style metadata. No business rows enter source code.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
mkdirSync('.sites-runtime/tools', { recursive: true });
await build({ entryPoints: ['lib/kingdee-xlsx.ts'], outfile: '.sites-runtime/tools/kingdee-xlsx.mjs', bundle: true, platform: 'node', format: 'esm' });
const { readKingdeeWorkbook } = await import('../.sites-runtime/tools/kingdee-xlsx.mjs');
const { template } = readKingdeeWorkbook(readFileSync(resolve('../资料/金蝶/目标模板/casebang 存销明细 2026.10.09.xlsx')), { sheet: '明细', formatting: true });
if (template?.columns.length !== 92) throw new Error('原模板不是92列');
writeFileSync('data/kingdee-template.json', JSON.stringify(template));
console.log(JSON.stringify({ columns: template.columns.length, styles: template.styles.length, frozenColumns: template.frozenColumns,
  lastHeaders: template.columns.slice(81).map(column => [column.key, column.label]), backgrounds: template.columns.slice(81).map(column => template.styles[column.headerStyle].background) }));
