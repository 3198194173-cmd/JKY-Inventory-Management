import { parentPort, workerData } from 'node:worker_threads';
import { writeFile } from 'node:fs/promises';
import { importKingdeeFiles, type ImportFile } from '../lib/kingdee-import';
import type { KingdeeRules } from '../lib/kingdee-types';

const data = workerData as { files: ImportFile[]; rules: KingdeeRules; output: string; baselineOnly?: boolean };
try {
  const result = await importKingdeeFiles(data.files, data.rules, data.baselineOnly);
  await writeFile(data.output, JSON.stringify(result));
  parentPort!.postMessage({ ok: true });
} catch (error) {
  parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : 'Excel解析失败' });
}
