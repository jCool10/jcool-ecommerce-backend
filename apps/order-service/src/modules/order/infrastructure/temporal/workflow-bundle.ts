import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { bundleWorkflowCode } from '@temporalio/worker';

// CWD-relative like MIGRATIONS_FOLDER: this file compiles to CJS for the app but runs as ESM under
// vitest, so neither __dirname nor import.meta works in both. The app directory is the CWD for the
// build, the tests and the image.
const WORKFLOWS_SOURCE = 'src/modules/order/infrastructure/temporal/workflows/index.ts';
export const CHECKOUT_SAGA_BUNDLE_FILE = 'dist/workflows/checkout-saga.bundle.js';

export const checkoutSagaWorkflowsPath = (): string => resolve(WORKFLOWS_SOURCE);

export async function bundleCheckoutSagaWorkflows(outFile: string): Promise<void> {
  const { code } = await bundleWorkflowCode({ workflowsPath: checkoutSagaWorkflowsPath() });
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, code);
}
