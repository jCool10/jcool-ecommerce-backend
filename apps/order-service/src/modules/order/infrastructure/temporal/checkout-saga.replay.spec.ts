import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker } from '@temporalio/worker';
import { installTemporalRuntime } from './temporal-runtime';
import { checkoutSagaWorkflowCode } from './workflow-bundle';
import { workflowTracingSinks } from './workflow-tracing';

// Histories recorded by checkout-saga-workflow.e2e-spec.ts and refund-order-workflow.e2e-spec.ts with
// CHECKOUT_SAGA_HISTORY_OUT set. A workflow change that fails here would break every run already open
// in production: it needs patched(). Replayed through the production bundle, tracing interceptors included.
const HISTORIES_DIR = resolve('src/modules/order/infrastructure/temporal/replay-histories');
const HISTORIES = readdirSync(HISTORIES_DIR).filter((file) => file.endsWith('.history.json'));

describe('CheckoutSaga and RefundOrder replay', () => {
  let code: string;

  beforeAll(async () => {
    installTemporalRuntime();
    code = await checkoutSagaWorkflowCode();
  }, 60_000);

  it('has a history for every way a run closes', () => {
    expect(HISTORIES.sort()).toEqual([
      'cancelled.history.json',
      'completed.history.json',
      'expired.history.json',
      'late-authorization.history.json',
      'refund-completed.history.json',
      'refund-failed.history.json',
      'refund-not-refundable.history.json',
      'refund-pending-then-completed.history.json',
      'try-out-of-stock.history.json',
    ]);
  });

  it.each(HISTORIES)(
    'replays %s with the current workflow code',
    async (file) => {
      const history: unknown = JSON.parse(readFileSync(join(HISTORIES_DIR, file), 'utf8'));

      await expect(
        Worker.runReplayHistory({ workflowBundle: { code }, replayName: file, sinks: workflowTracingSinks() }, history),
      ).resolves.toBeUndefined();
    },
    30_000,
  );
});
