/**
 * Prebuilds the workflow bundle the worker loads in production, so a pod never runs webpack at boot.
 * Usage: tsx scripts/bundle-workflows.ts [outFile]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { bundleWorkflowCode } from '@temporalio/worker';

const API_ROOT = resolve(__dirname, '..');
const WORKFLOWS_PATH = resolve(API_ROOT, 'src/modules/order/saga/workflows');
const DEFAULT_OUT_FILE = resolve(API_ROOT, 'dist/workflows/checkout-saga.bundle.js');

async function main(): Promise<void> {
  const outFile = resolve(process.argv[2] ?? DEFAULT_OUT_FILE);
  const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH });
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, code);
  console.log(`workflow bundle written to ${outFile} (${Math.round(code.length / 1024)} KiB)`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
