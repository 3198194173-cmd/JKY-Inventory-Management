import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
await mkdir('.sites-runtime/tests',{recursive:true});
await build({entryPoints:['tests/goods-price.test.ts'],outfile:'.sites-runtime/tests/goods-price.mjs',bundle:true,platform:'node',target:'node24',format:'esm'});
const result=spawnSync(process.execPath,['--test','.sites-runtime/tests/goods-price.mjs'],{stdio:'inherit'});process.exitCode=result.status||0;
