import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir('.sites-runtime/tests',{recursive:true});
let result=spawnSync(process.execPath,['scripts/build-worker.mjs'],{stdio:'inherit'});
if(result.status)process.exit(result.status);
await build({entryPoints:['tests/collections.test.ts'],outfile:'.sites-runtime/tests/collections.mjs',bundle:true,platform:'node',target:'node24',format:'esm'});
result=spawnSync(process.execPath,['--test','.sites-runtime/tests/collections.mjs'],{stdio:'inherit'});
process.exitCode=result.status||0;
