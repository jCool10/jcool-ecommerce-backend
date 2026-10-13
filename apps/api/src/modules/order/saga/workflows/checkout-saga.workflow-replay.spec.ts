import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import { bundleWorkflowCode, Worker, type WorkflowBundle } from '@temporalio/worker';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  checkoutStart,
  createSagaTestBed,
  recordingActivities,
  reserve,
  startSaga,
  withWorker,
  WORKFLOWS_PATH,
  type CheckoutSagaHandle,
  type SagaTestBed,
} from '../../testing/checkout-saga-workflow.harness';
import { cancelUpdate, paymentAuthorizedSignal } from '../checkout-saga.contract';

// A change that fails here would break every saga still running when it deploys: gate it behind
// patched(), or re-record with UPDATE_WORKFLOW_HISTORIES=1 only when no old run can still be open.
const FIXTURES = resolve(__dirname, '__fixtures__');
const RECORD = process.env.UPDATE_WORKFLOW_HISTORIES === '1';

const scenarios: Record<string, (handle: CheckoutSagaHandle) => Promise<void>> = {
  'happy-path': async (handle) => {
    await reserve(handle);
    await handle.signal(paymentAuthorizedSignal, {
      paymentId: 'payment-1',
      amountMinor: 240_000,
      currency: 'VND',
      authorizedAt: '2026-03-01T09:30:00.000Z',
    });
  },
  'cancel-compensation': async (handle) => {
    await reserve(handle);
    await handle.executeUpdate(cancelUpdate, { args: [{ by: 'user' }] });
  },
};

const fixturePath = (name: string) => resolve(FIXTURES, `checkout-saga.${name}.history.json`);

async function record(bed: SagaTestBed, name: string, drive: (handle: CheckoutSagaHandle) => Promise<void>) {
  const { activities } = recordingActivities();
  const history = await withWorker(bed, activities, async (taskQueue) => {
    const handle = await startSaga(bed.env, taskQueue, await checkoutStart(bed.env));
    await drive(handle);
    await handle.result();
    return handle.fetchHistory();
  });
  await writeFile(fixturePath(name), `${historyToJSON(history)}\n`);
}

describe('CheckoutSaga replay', { timeout: 120_000 }, () => {
  let workflowBundle: WorkflowBundle;

  beforeAll(async () => {
    if (RECORD) {
      const bed = await createSagaTestBed();
      try {
        for (const [name, drive] of Object.entries(scenarios)) await record(bed, name, drive);
      } finally {
        await bed.env.teardown();
      }
    }
    workflowBundle = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH });
  }, 180_000);

  it.each(Object.keys(scenarios))('replays the recorded %s history without nondeterminism', async (name) => {
    const history: unknown = JSON.parse(await readFile(fixturePath(name), 'utf8'));

    await expect(Worker.runReplayHistory({ workflowBundle }, history)).resolves.toBeUndefined();
  });
});
