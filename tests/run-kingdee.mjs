import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir('.sites-runtime/tests', { recursive: true });
await build({ entryPoints: ['scripts/kingdee-import-worker.ts'], outfile: 'build-node/kingdee-import.mjs', bundle: true, platform: 'node', target: 'node24', format: 'esm' });
await build({ entryPoints: ['tests/kingdee.test.ts'], outfile: '.sites-runtime/tests/kingdee.mjs', bundle: true, platform: 'node', target: 'node24', format: 'esm' });
const result = spawnSync(process.execPath, ['--test', '.sites-runtime/tests/kingdee.mjs'], { stdio: 'inherit' });
process.exitCode = result.status || 0;
