import { ApplicationFailure, WorkflowUpdateFailedError } from '@temporalio/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CheckoutSagaStep, Compensation } from '../../domain/checkout-saga-step';
import { OrderStatus } from '../../domain/order-status';
import type { OrderChangeInput } from '../activities/checkout-saga.activities';
import {
  checkoutStart,
  createSagaTestBed,
  deferred,
  ORDER_TOTAL,
  recordingActivities,
  reserve,
  sagaState,
  startSaga,
  stepAttribute,
  TEST_TIMINGS,
  waitForState,
  withWorker,
  type CheckoutSagaHandle,
  type SagaTestBed,
} from '../../testing/checkout-saga-workflow.harness';
import {
  cancelUpdate,
  CHECKOUT_DEADLINE_ATTRIBUTE,
  CHECKOUT_NOT_CANCELLABLE,
  paymentAuthorizedSignal,
  type PaymentAuthorizedPayload,
} from '../checkout-saga.contract';

const { AWAITING_AUTH, COMMITTING_STOCK, COMPLETED, COMPENSATING, COMPENSATED } = CheckoutSagaStep;
const { RELEASE_STOCK, CANCEL_PAYMENT } = Compensation;

let bed: SagaTestBed;

beforeAll(async () => {
  bed = await createSagaTestBed();
}, 180_000);

afterAll(async () => {
  await bed?.env.teardown();
});

const authorization = (overrides: Partial<PaymentAuthorizedPayload> = {}): PaymentAuthorizedPayload => ({
  paymentId: 'payment-1',
  amountMinor: ORDER_TOTAL.totalMinor,
  currency: ORDER_TOTAL.currency,
  authorizedAt: new Date().toISOString(),
  ...overrides,
});

const authorize = (handle: CheckoutSagaHandle, overrides: Partial<PaymentAuthorizedPayload> = {}) =>
  handle.signal(paymentAuthorizedSignal, authorization(overrides));

const orderChanges = (callsTo: ReturnType<typeof recordingActivities>['callsTo']) =>
  callsTo('applyOrderChange').map(([input]) => input as OrderChangeInput);

describe('CheckoutSaga workflow', { timeout: 60_000 }, () => {
  describe('the Try', () => {
    it('places the order on a held stock and parks awaiting the authorization', async () => {
      const { activities, callsTo } = recordingActivities();
      await withWorker(bed, activities, async (taskQueue) => {
        const input = await checkoutStart(bed.env);
        const handle = await startSaga(bed.env, taskQueue, input);

        expect(await reserve(handle)).toBe('HELD');

        expect(await sagaState(handle)).toEqual({
          step: AWAITING_AUTH,
          pendingCompensations: [],
          deadlineAt: input.deadlineAt,
        });
        expect(callsTo('tryReserve')).toEqual([
          [{ orderId: input.orderId, lines: input.lines, holdUntil: input.holdUntil }],
        ]);
        expect(callsTo('applyTryResult')).toEqual([
          [
            {
              orderId: input.orderId,
              from: OrderStatus.RESERVING,
              change: { status: OrderStatus.PENDING },
              cause: null,
              verdict: 'HELD',
              idempotency: input.idempotency,
            },
          ],
        ]);
        const { typedSearchAttributes } = await handle.describe();
        expect(typedSearchAttributes.get(CHECKOUT_DEADLINE_ATTRIBUTE)).toEqual(new Date(input.deadlineAt));
        expect(await stepAttribute(handle)).toBe(AWAITING_AUTH);
        await handle.terminate();
      });
    });

    it.each(['OUT_OF_STOCK', 'CONTENDED', 'CONFLICT'] as const)(
      'rejects the order on %s with nothing to release',
      async (verdict) => {
        const { activities, callsTo } = recordingActivities({ tryReserve: () => Promise.resolve(verdict) });
        await withWorker(bed, activities, async (taskQueue) => {
          const handle = await startSaga(bed.env, taskQueue, await checkoutStart(bed.env));

          expect(await reserve(handle)).toBe(verdict);
          await handle.result();

          expect(callsTo('applyTryResult')[0][0]).toMatchObject({
            change: { status: OrderStatus.REJECTED, reason: `try:${verdict.toLowerCase()}` },
            cause: null,
          });
          expect(callsTo('releaseStock')).toEqual([]);
          expect(await stepAttribute(handle)).toBe(COMPENSATED);
        });
      },
    );

    it('answers a Try that outlived its budget as TIMEOUT, after releasing whatever it may hold', async () => {
      const lateTry = deferred<'HELD'>();
      const { activities, calls } = recordingActivities({ tryReserve: () => lateTry.promise });
      await withWorker(bed, activities, async (taskQueue) => {
        const handle = await startSaga(bed.env, taskQueue, await checkoutStart(bed.env));

        expect(await reserve(handle)).toBe('TIMEOUT');

        expect(calls.map(({ name }) => name)).toEqual(['tryReserve', 'applyTryResult', 'releaseStock']);
        expect(calls[1].args[0]).toMatchObject({
          change: { status: OrderStatus.REJECTED, reason: 'try:timeout' },
          cause: 'try_failed',
        });
        await handle.result();
        lateTry.resolve('HELD');
      });
    });

    it('answers a Try that failed as ERROR and releases', async () => {
      const { activities, callsTo } = recordingActivities({
        tryReserve: () => Promise.reject(new Error('pool exhausted')),
      });
      await withWorker(bed, activities, async (taskQueue) => {
        const handle = await startSaga(bed.env, taskQueue, await checkoutStart(bed.env));

        expect(await reserve(handle)).toBe('ERROR');
        await handle.result();

        expect(callsTo('tryReserve')).toHaveLength(1);
        expect(callsTo('releaseStock')).toHaveLength(1);
      });
    });

    it('abandons a Try whose budget ran out before the saga started, without asking for stock', async () => {
      const { activities, callsTo } = recordingActivities();
      await withWorker(bed, activities, async (taskQueue) => {
        const now = await bed.env.currentTimeMs();
        const placedAt = new Date(now - TEST_TIMINGS.tryTimeoutMs - 1).toISOString();
        const handle = await startSaga(bed.env, taskQueue, await checkoutStart(bed.env, { placedAt }));

        expect(await reserve(handle)).toBe('ABANDONED');
        await handle.result();

        expect(callsTo('tryReserve')).toEqual([]);
        expect(callsTo('applyTryResult')[0][0]).toMatchObject({
          change: { status: OrderStatus.REJECTED, reason: 'try:abandoned' },
        });
        expect(callsTo('releaseStock')).toHaveLength(1);
      });
    });

    it('runs the Try once for a reserve update sent twice, answering both the same', async () => {
      const { activities, callsTo } = recordingActivities();
      await withWorker(bed, activities, async (taskQueue) => {
        const handle = await startSaga(bed.env, taskQueue, await checkoutStart(bed.env));

        await expect(Promise.all([reserve(handle), reserve(handle)])).resolves.toEqual(['HELD', 'HELD']);

        expect(callsTo('tryReserve')).toHaveLength(1);
        await handle.terminate();
      });
    });
  });

  describe('the authorization', () => {
    it('commits the stock, then captures, then marks the order paid', async () => {
      const { activities, calls, callsTo } = recordingActivities();
      await withWorker(bed, activities, async (taskQueue) => {
        const input = await checkoutStart(bed.env);
        const handle = await startSaga(bed.env, taskQueue, input);
        await reserve(handle);

        await authorize(handle);
        await handle.result();

        expect(calls.map(({ name }) => name).slice(2)).toEqual([
          'applyOrderChange',
          'commitStock',
          'capturePayment',
          'applyOrderChange',
        ]);
        expect(orderChanges(callsTo)).toEqual([
          {
            orderId: input.orderId,
            from: OrderStatus.PENDING,
            change: { status: OrderStatus.CONFIRMING },
            cause: null,
          },
          {
            orderId: input.orderId,
            from: OrderStatus.CONFIRMING,
            change: { status: OrderStatus.PAID, reason: 'payment:captured' },
            cause: null,
          },
        ]);
        expect(await stepAttribute(handle)).toBe(COMPLETED);
      });
    });

    it('fails the order and voids the money when the authorization is for a different amount', async () => {
      const { activities, callsTo } = recordingActivities();
      await withWorker(bed, activities, async (taskQueue) => {
        const handle = await startSaga(bed.env, taskQueue, await checkoutStart(bed.env));
        await reserve(handle);

        await authorize(handle, { amountMinor: 1 });
        await handle.result();

        expect(orderChanges(callsTo)).toEqual([
          expect.objectContaining({
            change: { status: OrderStatus.FAILED, reason: 'payment:amount_mismatch' },
            cause: 'amount_mismatch',
          }),
        ]);
        expect(callsTo('releaseStock')).toHaveLength(1);
        expect(callsTo('cancelPayment')).toHaveLength(1);
        expect(callsTo('commitStock')).toEqual([]);
      });
    });

    it('acts on a repeated authorization once', async () => {
      const { activities, callsTo } = recordingActivities();
      await withWorker(bed, activities, async (taskQueue) => {
        const handle = await startSaga(bed.env, taskQueue, await checkoutStart(bed.env));
        await reserve(handle);

        await authorize(handle);
        await authorize(handle);
        await handle.result();

        expect(callsTo('commitStock')).toHaveLength(1);
        expect(callsTo('capturePayment')).toHaveLength(1);
        expect(orderChanges(callsTo)).toHaveLength(2);
      });
    });

    it('voids an authorization that arrives while the saga is already unwinding, exactly once', async () => {
      const release = deferred<void>();
      const { activities, callsTo } = recordingActivities({
        tryReserve: () => Promise.reject(new Error('pool exhausted')),
        releaseStock: () => release.promise,
      });
      await withWorker(bed, activities, async (taskQueue) => {
        const handle = await startSaga(bed.env, taskQueue, await checkoutStart(bed.env));
        await reserve(handle);

        await authorize(handle);
        await authorize(handle);
        const state = await waitForState(handle, ({ pendingCompensations }) =>
          pendingCompensations.includes(CANCEL_PAYMENT),
        );
        release.resolve();
        await handle.result();

        expect(state.pendingCompensations).toEqual([RELEASE_STOCK, CANCEL_PAYMENT]);
        expect(callsTo('cancelPayment')).toHaveLength(1);
        expect(callsTo('recordCompensation')).toEqual([['late_authorization']]);
      });
    });
  });

  describe('settling', () => {
    it('voids the money when the stock can no longer be committed', async () => {
      const { activities, callsTo } = recordingActivities({ commitStock: () => Promise.resolve('CONFLICT') });
      await withWorker(bed, activities, async (taskQueue) => {
        const handle = await startSaga(bed.env, taskQueue, await checkoutStart(bed.env));
        await reserve(handle);

        await authorize(handle);
        await handle.result();

        expect(orderChanges(callsTo)[1]).toMatchObject({
          from: OrderStatus.CONFIRMING,
          change: { status: OrderStatus.FAILED, reason: 'stock:commit_conflict' },
          cause: 'commit_conflict',
        });
        expect(callsTo('capturePayment')).toEqual([]);
        expect(callsTo('cancelPayment')).toHaveLength(1);
        expect(callsTo('releaseStock')).toEqual([]);
      });
    });

    it('restocks and voids when the money cannot be captured', async () => {
      const { activities, callsTo } = recordingActivities({
        capturePayment: () => Promise.resolve('NOT_CAPTURABLE'),
      });
      await withWorker(bed, activities, async (taskQueue) => {
        const handle = await startSaga(bed.env, taskQueue, await checkoutStart(bed.env));
        await reserve(handle);

        await authorize(handle);
        await handle.result();

        expect(orderChanges(callsTo)[1]).toMatchObject({
          change: { status: OrderStatus.FAILED, reason: 'payment:not_capturable' },
          cause: 'capture_failed',
        });
        expect(callsTo('restock')).toHaveLength(1);
        expect(callsTo('cancelPayment')).toHaveLength(1);
      });
    });

    it('retries a capture that could not answer until it does, without compensating', async () => {
      let attempts = 0;
      const { activities, callsTo } = recordingActivities({
        capturePayment: () => {
          attempts++;
          return attempts <= 3
            ? Promise.reject(ApplicationFailure.retryable('gateway timeout', 'PaymentUnavailableError'))
            : Promise.resolve('CAPTURED');
        },
      });
      await withWorker(bed, activities, async (taskQueue) => {
        const handle = await startSaga(bed.env, taskQueue, await checkoutStart(bed.env));
        await reserve(handle);

        await authorize(handle);
        await handle.result();

        expect(callsTo('capturePayment')).toHaveLength(4);
        expect(orderChanges(callsTo).map(({ change }) => change.status)).toEqual([
          OrderStatus.CONFIRMING,
          OrderStatus.PAID,
        ]);
        expect(callsTo('cancelPayment')).toEqual([]);
        expect(callsTo('restock')).toEqual([]);
      });
    });
  });

  describe('the payment deadline', () => {
    it('keeps waiting until the grace has run out, then expires and unwinds both participants', async () => {
      const unwind = deferred<void>();
      const { activities, callsTo } = recordingActivities({
        releaseStock: () => unwind.promise,
        cancelPayment: () => unwind.promise,
      });
      await withWorker(bed, activities, async (taskQueue) => {
        const input = await checkoutStart(bed.env);
        const handle = await startSaga(bed.env, taskQueue, input);
        await reserve(handle);
        const graceEndsAt = Date.parse(input.deadlineAt) + TEST_TIMINGS.authGraceMs;

        await bed.env.sleep(graceEndsAt - (await bed.env.currentTimeMs()) - 1_000);
        expect((await sagaState(handle)).step).toBe(AWAITING_AUTH);
        await bed.env.sleep(1_000);
        const expired = await waitForState(handle, ({ step }) => step !== AWAITING_AUTH);
        unwind.resolve();
        await handle.result();

        expect(expired).toMatchObject({ step: COMPENSATING, pendingCompensations: [RELEASE_STOCK, CANCEL_PAYMENT] });
        expect(orderChanges(callsTo)).toEqual([
          expect.objectContaining({
            from: OrderStatus.PENDING,
            change: { status: OrderStatus.EXPIRED, reason: 'saga:deadline' },
            cause: 'expired',
          }),
        ]);
      });
    });

    it('still takes an authorization that lands after the deadline but inside the grace', async () => {
      const { activities, callsTo } = recordingActivities();
      await withWorker(bed, activities, async (taskQueue) => {
        const input = await checkoutStart(bed.env);
        const handle = await startSaga(bed.env, taskQueue, input);
        await reserve(handle);

        await bed.env.sleep(Date.parse(input.deadlineAt) - (await bed.env.currentTimeMs()) + 1_000);
        await authorize(handle);
        await handle.result();

        expect(orderChanges(callsTo).map(({ change }) => change.status)).toEqual([
          OrderStatus.CONFIRMING,
          OrderStatus.PAID,
        ]);
        expect(callsTo('cancelPayment')).toEqual([]);
      });
    });
  });

  describe('cancel', () => {
    it('cancels an order awaiting payment and answers once both participants are unwound', async () => {
      const { activities, callsTo } = recordingActivities();
      await withWorker(bed, activities, async (taskQueue) => {
        const input = await checkoutStart(bed.env);
        const handle = await startSaga(bed.env, taskQueue, input);
        await reserve(handle);

        // Accepted first, so the reason is deterministic; the admin cancel joins it.
        const userCancel = await handle.startUpdate(cancelUpdate, { args: [{ by: 'user' }], waitForStage: 'ACCEPTED' });
        const adminAnswer = await handle.executeUpdate(cancelUpdate, { args: [{ by: 'admin' }] });
        const answers = [await userCancel.result(), adminAnswer];
        await handle.result();

        expect(answers).toEqual([{ settled: true }, { settled: true }]);
        expect(orderChanges(callsTo)).toEqual([
          {
            orderId: input.orderId,
            from: OrderStatus.PENDING,
            change: { status: OrderStatus.CANCELLED, reason: 'user:cancel' },
            cause: 'cancelled',
          },
        ]);
        expect(callsTo('releaseStock')).toHaveLength(1);
        expect(callsTo('cancelPayment')).toHaveLength(1);
      });
    });

    it('refuses a cancel once the money is being taken', async () => {
      const commit = deferred<'COMMITTED'>();
      const { activities, callsTo } = recordingActivities({ commitStock: () => commit.promise });
      await withWorker(bed, activities, async (taskQueue) => {
        const handle = await startSaga(bed.env, taskQueue, await checkoutStart(bed.env));
        await reserve(handle);
        await authorize(handle);
        await waitForState(handle, ({ step }) => step === COMMITTING_STOCK);

        const refusal = await handle
          .executeUpdate(cancelUpdate, { args: [{ by: 'user' }] })
          .catch((error: unknown) => error);
        commit.resolve('COMMITTED');
        await handle.result();

        expect(refusal).toBeInstanceOf(WorkflowUpdateFailedError);
        expect((refusal as WorkflowUpdateFailedError).cause).toMatchObject({ type: CHECKOUT_NOT_CANCELLABLE });
        expect(orderChanges(callsTo).map(({ change }) => change.status)).toEqual([
          OrderStatus.CONFIRMING,
          OrderStatus.PAID,
        ]);
      });
    });

    it('answers unsettled when the unwinding outlasts the wait, and keeps unwinding', async () => {
      const unwind = deferred<void>();
      const { activities } = recordingActivities({ cancelPayment: () => unwind.promise });
      await withWorker(bed, activities, async (taskQueue) => {
        const timings = { ...TEST_TIMINGS, cancelWaitMs: 500 };
        const handle = await startSaga(bed.env, taskQueue, await checkoutStart(bed.env, { timings }));
        await reserve(handle);

        const answer = await handle.executeUpdate(cancelUpdate, { args: [{ by: 'user' }] });
        unwind.resolve();
        await handle.result();

        expect(answer).toEqual({ settled: false });
      });
    });
  });

  describe('compensation', () => {
    it('releases the stock while the void is still failing, and finishes once the void lands', async () => {
      let voids = 0;
      const { activities, callsTo } = recordingActivities({
        cancelPayment: () => {
          voids++;
          return voids <= 2
            ? Promise.reject(ApplicationFailure.retryable('gateway timeout', 'PaymentUnavailableError'))
            : Promise.resolve();
        },
      });
      await withWorker(bed, activities, async (taskQueue) => {
        const handle = await startSaga(bed.env, taskQueue, await checkoutStart(bed.env));
        await reserve(handle);

        await handle.executeUpdate(cancelUpdate, { args: [{ by: 'user' }] });
        await handle.result();

        expect(callsTo('releaseStock')).toHaveLength(1);
        expect(callsTo('cancelPayment')).toHaveLength(3);
        expect(await stepAttribute(handle)).toBe(COMPENSATED);
      });
    });

    it('stays compensating while a participant reports a conflict', async () => {
      const { activities, callsTo } = recordingActivities({
        cancelPayment: () =>
          Promise.reject(ApplicationFailure.retryable('CANCEL_PAYMENT conflicts', 'CAPTURED_CONFLICT')),
      });
      await withWorker(bed, activities, async (taskQueue) => {
        const handle = await startSaga(bed.env, taskQueue, await checkoutStart(bed.env));
        await reserve(handle);

        await handle.executeUpdate(cancelUpdate, { args: [{ by: 'user' }] });
        const state = await waitForState(
          handle,
          ({ step, pendingCompensations }) => step === COMPENSATING && !pendingCompensations.includes(RELEASE_STOCK),
        );

        expect(state).toMatchObject({ step: COMPENSATING, pendingCompensations: [CANCEL_PAYMENT] });
        expect(await stepAttribute(handle)).toBe(COMPENSATING);
        expect(callsTo('releaseStock')).toHaveLength(1);
        await handle.terminate();
      });
    });

    it('restocks and voids in parallel after a failed capture', async () => {
      const both = deferred<void>();
      let started = 0;
      const startedBoth = () => {
        started++;
        if (started === 2) both.resolve();
        return both.promise;
      };
      const { activities } = recordingActivities({
        capturePayment: () => Promise.resolve('NOT_CAPTURABLE'),
        restock: startedBoth,
        cancelPayment: startedBoth,
      });
      await withWorker(bed, activities, async (taskQueue) => {
        const handle = await startSaga(bed.env, taskQueue, await checkoutStart(bed.env));
        await reserve(handle);

        await authorize(handle);
        await handle.result();

        expect(started).toBe(2);
      });
    });
  });

  describe('a late authorization run', () => {
    const lateStart = (orderId: string) => ({ mode: 'lateAuthorization' as const, orderId, timings: TEST_TIMINGS });

    it('leaves the money of an order that was paid', async () => {
      const { activities, callsTo } = recordingActivities({
        loadLateAuthorizationContext: () => Promise.resolve({ status: OrderStatus.PAID }),
      });
      await withWorker(bed, activities, async (taskQueue) => {
        const handle = await startSaga(bed.env, taskQueue, lateStart('late-paid'));

        await handle.result();

        expect(callsTo('cancelPayment')).toEqual([]);
        expect(await stepAttribute(handle)).toBe(COMPLETED);
      });
    });

    it('voids the money of an order that is no longer waiting for it, and refuses a cancel meanwhile', async () => {
      const unwind = deferred<void>();
      const { activities, callsTo } = recordingActivities({
        loadLateAuthorizationContext: () => Promise.resolve({ status: OrderStatus.EXPIRED }),
        cancelPayment: () => unwind.promise,
      });
      await withWorker(bed, activities, async (taskQueue) => {
        const handle = await startSaga(bed.env, taskQueue, lateStart('late-expired'));
        await waitForState(handle, ({ step }) => step === COMPENSATING);

        const refusal = await handle
          .executeUpdate(cancelUpdate, { args: [{ by: 'admin' }] })
          .catch((error: unknown) => error);
        unwind.resolve();
        await handle.result();

        expect(refusal).toBeInstanceOf(WorkflowUpdateFailedError);
        expect(callsTo('cancelPayment')).toEqual([['late-expired']]);
        expect(callsTo('recordCompensation')).toEqual([['late_authorization']]);
        expect(await stepAttribute(handle)).toBe(COMPENSATED);
      });
    });
  });
});
