import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
import { installTemporalRuntime } from './temporal-runtime';
import { checkoutSagaWorkflowsPath } from './workflow-bundle';

// Histories recorded by checkout-saga-workflow.e2e-spec.ts with CHECKOUT_SAGA_HISTORY_OUT set. A
// workflow change that fails here would break every run already open in production: it needs patched().
const HISTORIES_DIR = resolve('src/modules/order/infrastructure/temporal/replay-histories');
const HISTORIES = readdirSync(HISTORIES_DIR).filter((file) => file.endsWith('.history.json'));

describe('CheckoutSaga replay', () => {
  let code: string;

  beforeAll(async () => {
    installTemporalRuntime();
    ({ code } = await bundleWorkflowCode({ workflowsPath: checkoutSagaWorkflowsPath() }));
  }, 60_000);

  it('has a history for every way a run closes', () => {
    expect(HISTORIES.sort()).toEqual([
      'cancelled.history.json',
      'completed.history.json',
      'expired.history.json',
      'late-authorization.history.json',
      'try-out-of-stock.history.json',
    ]);
  });

  it.each(HISTORIES)(
    'replays %s with the current workflow code',
    async (file) => {
      const history: unknown = JSON.parse(readFileSync(join(HISTORIES_DIR, file), 'utf8'));

      await expect(
        Worker.runReplayHistory({ workflowBundle: { code }, replayName: file }, history),
      ).resolves.toBeUndefined();
    },
    30_000,
  );
});
