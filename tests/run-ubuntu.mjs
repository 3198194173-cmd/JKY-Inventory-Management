import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
await import('../scripts/build-worker.mjs');
await build({entryPoints:['tests/ubuntu-store.test.ts'],outfile:'.sites-runtime/tests/ubuntu-store.mjs',bundle:true,platform:'node',format:'esm',target:'node24'});
for(const args of [['--test','.sites-runtime/tests/ubuntu-store.mjs'],['tests/ubuntu-http.mjs']]) {
  const result=spawnSync(process.execPath,args,{stdio:'inherit'});
  if(result.status!==0)process.exit(result.status||1);
}
