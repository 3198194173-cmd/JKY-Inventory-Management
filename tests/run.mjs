import {build} from "esbuild";
import {mkdir} from "node:fs/promises";
import {spawnSync} from "node:child_process";
await mkdir(".sites-runtime/tests",{recursive:true});
await build({entryPoints:["tests/inventory.test.ts"],outfile:".sites-runtime/tests/inventory.test.mjs",bundle:true,platform:"node",format:"esm",target:"node22"});
const result=spawnSync(process.execPath,["--test",".sites-runtime/tests/inventory.test.mjs"],{stdio:"inherit"});
process.exitCode=result.status??1;
