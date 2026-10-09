import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
await import('../scripts/build-worker.mjs');
assert.doesNotMatch(readFileSync('build-node/worker.mjs','utf8'), /^import .* from ["'](?:echarts|zrender)(?:\/|["'])/m, '部署worker必须包含ECharts，不依赖Next未复制的包');
await build({entryPoints:['tests/ubuntu-store.test.ts'],outfile:'.sites-runtime/tests/ubuntu-store.mjs',bundle:true,platform:'node',format:'esm',target:'node24',external:['sharp']});
await build({entryPoints:['tests/warehouse-alerts.test.ts'],outfile:'.sites-runtime/tests/warehouse-alerts.mjs',bundle:true,platform:'node',format:'esm',target:'node24',external:['sharp']});
await build({entryPoints:['tests/transit.test.ts'],outfile:'.sites-runtime/tests/transit.mjs',bundle:true,platform:'node',format:'esm',target:'node24',external:['sharp']});
for(const args of [['--test','.sites-runtime/tests/transit.mjs'],['--test','.sites-runtime/tests/ubuntu-store.mjs'],['--test','.sites-runtime/tests/warehouse-alerts.mjs'],['tests/ubuntu-http.mjs']]) {
  const result=spawnSync(process.execPath,args,{stdio:'inherit'});
  if(result.status!==0)process.exit(result.status||1);
}
