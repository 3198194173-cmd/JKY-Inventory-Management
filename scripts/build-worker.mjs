import { build } from 'esbuild';
// Next bundles ECharts in server chunks rather than copying its package into
// standalone/node_modules. Bundle it here as well so the deployed worker can
// render cards; sharp stays external because it loads native binaries.
await build({entryPoints:['scripts/worker.ts'],outfile:'build-node/worker.mjs',bundle:true,platform:'node',target:'node24',format:'esm',external:['sharp']});
