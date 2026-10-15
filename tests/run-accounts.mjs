import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir('.sites-runtime/tests',{recursive:true});
await build({entryPoints:['tests/accounts.test.ts'],outfile:'.sites-runtime/tests/accounts.mjs',bundle:true,platform:'node',format:'esm',target:'node24',external:['sharp']});
const r=spawnSync(process.execPath,['--test','.sites-runtime/tests/accounts.mjs'],{stdio:'inherit'});process.exitCode=r.status||0;
