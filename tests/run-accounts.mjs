import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir('.sites-runtime/tests',{recursive:true});
await build({entryPoints:['tests/accounts.test.ts'],outfile:'.sites-runtime/tests/accounts.mjs',bundle:true,platform:'node',format:'esm',target:'node24',external:['sharp']});
await build({entryPoints:['tests/warehouse-sharing.test.ts'],outfile:'.sites-runtime/tests/warehouse-sharing.mjs',bundle:true,platform:'node',format:'esm',target:'node24',external:['sharp']});
for(const file of ['accounts','warehouse-sharing']){const r=spawnSync(process.execPath,['--test',`.sites-runtime/tests/${file}.mjs`],{stdio:'inherit'});if(r.status!==0){process.exitCode=r.status||1;break;}}
