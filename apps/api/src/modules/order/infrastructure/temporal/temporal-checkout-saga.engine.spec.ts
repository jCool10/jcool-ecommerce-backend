import {
  ApplicationFailure,
  type Client,
  WithStartWorkflowOperation,
  WorkflowIdConflictPolicy,
  WorkflowNotFoundError,
  WorkflowUpdateFailedError,
} from '@temporalio/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CheckoutEngineUnavailableError,
  CheckoutNotCancellableError,
  type CheckoutStart,
} from '../../application/ports/checkout-saga-engine.port';
import {
  cancelUpdate,
  CHECKOUT_NOT_CANCELLABLE,
  paymentAuthorizedSignal,
  reserveUpdate,
} from '../../saga/checkout-saga.contract';
import { checkoutSagaSettings } from '../../testing/checkout-saga-settings.double';
import { TemporalCheckoutSagaEngine } from './temporal-checkout-saga.engine';
import type { TemporalSettings } from './temporal.providers';

const NOW = new Date('2026-03-01T09:00:00.000Z');
const ORDER_ID = '900001';
const settings = checkoutSagaSettings();
const temporal: TemporalSettings = {
  address: 'localhost:7233',
  namespace: 'jcool',
  taskQueue: 'checkout-saga',
  workerEnabled: true,
  workerShutdownGraceMs: 0,
  activityConcurrency: 2,
  workflowBundlePath: 'dist/workflows/checkout-saga.bundle.js',
  workflowBundleRequired: false,
};
const TIMINGS = {
  tryTimeoutMs: settings.tryTimeoutMs,
  authGraceMs: settings.authGraceMs,
  cancelWaitMs: settings.cancelWaitMs,
  activityTimeoutMs: settings.activityTimeoutMs,
  retryBaseMs: settings.retryBaseMs,
  retryCapMs: settings.retryCapMs,
};

const START: CheckoutStart = {
  orderId: ORDER_ID,
  lines: [{ skuId: 'sku-1', quantity: 2 }],
  totalMinor: 240_000,
  currency: 'VND',
  placedAt: NOW,
  deadlineAt: new Date('2026-03-01T10:00:00.000Z'),
  holdUntil: new Date('2026-03-01T11:00:00.000Z'),
  idempotency: { scope: 'user:u1', key: 'key-1' },
};

function build() {
  const handle = { executeUpdate: vi.fn(() => Promise.resolve({ settled: true })) };
  const client = {
    connection: { withDeadline: vi.fn((_deadline: number, call: () => Promise<unknown>) => call()) },
    workflow: {
      executeUpdateWithStart: vi.fn(() => Promise.resolve({ verdict: 'HELD' })),
      getHandle: vi.fn(() => handle),
      signalWithStart: vi.fn(() => Promise.resolve()),
      start: vi.fn(() => Promise.resolve()),
    },
  };
  const engine = new TemporalCheckoutSagaEngine(client as unknown as Client, temporal, settings);
  return { engine, client, handle };
}

const deadlineOf = (client: ReturnType<typeof build>['client']) => client.connection.withDeadline.mock.calls[0][0];

describe('TemporalCheckoutSagaEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('reserve', () => {
    it('starts or joins the order saga and waits on the reserve update under its fixed id', async () => {
      const { engine, client } = build();

      await expect(engine.reserve(START)).resolves.toBe('HELD');

      const [update, options] = client.workflow.executeUpdateWithStart.mock.calls[0] as unknown as [
        unknown,
        { startWorkflowOperation: WithStartWorkflowOperation<never>; updateId: string },
      ];
      expect(update).toBe(reserveUpdate);
      expect(options.updateId).toBe('reserve');
      expect(options.startWorkflowOperation).toBeInstanceOf(WithStartWorkflowOperation);
      expect(options.startWorkflowOperation.workflowTypeOrFunc).toBe('CheckoutSaga');
      expect(options.startWorkflowOperation.options).toEqual({
        workflowId: `checkout-${ORDER_ID}`,
        taskQueue: 'checkout-saga',
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        args: [
          {
            mode: 'checkout',
            orderId: ORDER_ID,
            lines: [{ skuId: 'sku-1', quantity: 2 }],
            totalMinor: 240_000,
            currency: 'VND',
            placedAt: '2026-03-01T09:00:00.000Z',
            deadlineAt: '2026-03-01T10:00:00.000Z',
            holdUntil: '2026-03-01T11:00:00.000Z',
            idempotency: { scope: 'user:u1', key: 'key-1' },
            timings: TIMINGS,
          },
        ],
      });
      expect(deadlineOf(client)).toBe(NOW.getTime() + settings.reserveWaitMs);
    });

    it('reports any failure to get an answer as the engine being unavailable', async () => {
      const { engine, client } = build();
      const cause = new Error('deadline exceeded');
      client.workflow.executeUpdateWithStart.mockRejectedValueOnce(cause);

      const error = await engine.reserve(START).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CheckoutEngineUnavailableError);
      expect((error as Error).cause).toBe(cause);
    });
  });

  describe('cancel', () => {
    it('sends the cancel update to the order saga, bounded a little past its own wait', async () => {
      const { engine, client, handle } = build();

      await expect(engine.cancel(ORDER_ID, 'admin')).resolves.toBe('accepted');

      expect(client.workflow.getHandle).toHaveBeenCalledWith(`checkout-${ORDER_ID}`);
      expect(handle.executeUpdate).toHaveBeenCalledWith(cancelUpdate, { args: [{ by: 'admin' }] });
      expect(deadlineOf(client)).toBe(NOW.getTime() + settings.cancelWaitMs + 5_000);
    });

    it('answers closed when no saga runs for the order any more', async () => {
      const { engine, handle } = build();
      handle.executeUpdate.mockRejectedValueOnce(new WorkflowNotFoundError('gone', `checkout-${ORDER_ID}`, undefined));

      await expect(engine.cancel(ORDER_ID, 'user')).resolves.toBe('closed');
    });

    it('turns the validator refusal into a domain refusal', async () => {
      const { engine, handle } = build();
      handle.executeUpdate.mockRejectedValueOnce(
        new WorkflowUpdateFailedError('rejected', ApplicationFailure.nonRetryable('no', CHECKOUT_NOT_CANCELLABLE)),
      );

      await expect(engine.cancel(ORDER_ID, 'user')).rejects.toBeInstanceOf(CheckoutNotCancellableError);
    });

    it.each([
      [
        'an update that failed for another reason',
        new WorkflowUpdateFailedError('boom', ApplicationFailure.create({})),
      ],
      ['an unreachable server', new Error('14 UNAVAILABLE')],
    ])('reports %s as the engine being unavailable', async (_label, failure) => {
      const { engine, handle } = build();
      handle.executeUpdate.mockRejectedValueOnce(failure);

      await expect(engine.cancel(ORDER_ID, 'user')).rejects.toBeInstanceOf(CheckoutEngineUnavailableError);
    });
  });

  describe('notifyAuthorized', () => {
    it('signals the saga, carrying a late-authorization start for a saga that has closed', async () => {
      const { engine, client } = build();

      await engine.notifyAuthorized(ORDER_ID, {
        paymentId: '800001',
        amountMinor: 240_000,
        currency: 'VND',
        authorizedAt: new Date('2026-03-01T09:30:00.000Z'),
      });

      expect(client.workflow.signalWithStart).toHaveBeenCalledExactlyOnceWith('CheckoutSaga', {
        workflowId: `checkout-${ORDER_ID}`,
        taskQueue: 'checkout-saga',
        args: [{ mode: 'lateAuthorization', orderId: ORDER_ID, timings: TIMINGS }],
        signal: paymentAuthorizedSignal,
        signalArgs: [
          { paymentId: '800001', amountMinor: 240_000, currency: 'VND', authorizedAt: '2026-03-01T09:30:00.000Z' },
        ],
      });
    });

    it('reports a failed signal as the engine being unavailable', async () => {
      const { engine, client } = build();
      client.workflow.signalWithStart.mockRejectedValueOnce(new Error('14 UNAVAILABLE'));

      await expect(
        engine.notifyAuthorized(ORDER_ID, { paymentId: 'p', amountMinor: 1, currency: 'VND', authorizedAt: NOW }),
      ).rejects.toBeInstanceOf(CheckoutEngineUnavailableError);
    });
  });

  describe('ensureStarted', () => {
    it('starts the saga, leaving one that already runs alone', async () => {
      const { engine, client } = build();

      await engine.ensureStarted({ ...START, idempotency: undefined });

      expect(client.workflow.start).toHaveBeenCalledExactlyOnceWith(
        'CheckoutSaga',
        expect.objectContaining({
          workflowId: `checkout-${ORDER_ID}`,
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
          args: [expect.objectContaining({ mode: 'checkout', idempotency: undefined })],
        }),
      );
    });

    it('reports a failed start as the engine being unavailable', async () => {
      const { engine, client } = build();
      client.workflow.start.mockRejectedValueOnce(new Error('14 UNAVAILABLE'));

      await expect(engine.ensureStarted(START)).rejects.toBeInstanceOf(CheckoutEngineUnavailableError);
    });
  });
});
