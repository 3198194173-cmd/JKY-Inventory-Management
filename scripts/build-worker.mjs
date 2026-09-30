import { build } from 'esbuild';
await build({entryPoints:['scripts/worker.ts'],outfile:'build-node/worker.mjs',bundle:true,platform:'node',target:'node24',format:'esm',packages:'external'});
