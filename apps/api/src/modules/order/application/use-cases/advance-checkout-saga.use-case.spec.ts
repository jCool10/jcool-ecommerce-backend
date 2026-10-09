import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { CheckoutSagaStep, Compensation } from '../../domain/checkout-saga-step';
import type { SagaTransition } from '../../domain/checkout-saga';
import type { CheckoutSaga, CheckoutSagaRepositoryPort } from '../ports/checkout-saga-repository.port';
import type { CheckoutSagaSettings } from '../saga/checkout-saga.settings';
import type { CheckoutSagaWriter } from '../saga/checkout-saga.writer';
import { AdvanceCheckoutSagaUseCase } from './advance-checkout-saga.use-case';

const { RESERVING, AWAITING_AUTH, COMMITTING_STOCK, CAPTURING, COMPLETED, COMPENSATING, COMPENSATED } =
  CheckoutSagaStep;
const { RELEASE_STOCK, RESTOCK, CANCEL_PAYMENT } = Compensation;

const ORDER_ID = '900001';
const deadlineAt = new Date('2026-03-01T10:00:00.000Z');
const graceMs = 180_000;
const settings: CheckoutSagaSettings = {
  leaseMs: 60_000,
  timing: { authGraceMs: graceMs, retryBaseMs: 1_000, retryCapMs: 300_000 },
  paymentDeadlineMs: 3_600_000,
  payCutoffMs: 1_980_000,
  tryTimeoutMs: 3_000,
  holdSafetyMs: 3_600_000,
};

const claimed = (step: CheckoutSaga['step'], pendingCompensations: Compensation[] = []): CheckoutSaga => ({
  orderId: ORDER_ID,
  step,
  pendingCompensations,
  deadlineAt,
  nextAttemptAt: new Date(),
  attempts: 0,
  leaseUntil: new Date(Date.now() + 60_000),
  lastError: null,
  version: 10,
});

function build(claims: Array<CheckoutSaga | null>) {
  const log: string[] = [];
  let version = 10;
  const sagas = {
    claim: vi.fn(() => {
      log.push('claim');
      return Promise.resolve(claims.shift() ?? null);
    }),
    renew: vi.fn((): Promise<number | null> => {
      log.push('renew');
      return Promise.resolve(++version);
    }),
  };
  const writer = {
    applyLeased: vi.fn((_lease: CheckoutSaga, transition: SagaTransition) => {
      log.push(`apply ${transition.step}`);
      return Promise.resolve(true);
    }),
  };
  const inventory = {
    commit: vi.fn(() => {
      log.push('commit');
      return Promise.resolve('COMMITTED' as const);
    }),
    release: vi.fn(() => {
      log.push('release');
      return Promise.resolve('RELEASED' as const);
    }),
    restock: vi.fn(() => {
      log.push('restock');
      return Promise.resolve('RESTOCKED' as const);
    }),
    tryReserve: vi.fn(),
  };
  const payment = {
    capture: vi.fn(() => {
      log.push('capture');
      return Promise.resolve('CAPTURED' as const);
    }),
    cancel: vi.fn(() => {
      log.push('cancel');
      return Promise.resolve('CANCELLED' as const);
    }),
    openSession: vi.fn(),
  };
  const metrics = fakeMetricsPort();
  const logError = vi.fn();
  const useCase = new AdvanceCheckoutSagaUseCase(
    sagas as unknown as CheckoutSagaRepositoryPort,
    writer as unknown as CheckoutSagaWriter,
    inventory,
    payment,
    settings,
    metrics,
    fakePinoLogger({ error: logError }),
  );
  const applied = () => writer.applyLeased.mock.calls.map(([lease, transition]) => ({ lease, transition }));
  return { useCase, sagas, writer, inventory, payment, metrics, logError, log, applied };
}

describe('AdvanceCheckoutSagaUseCase', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-01T09:30:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls no participant and writes nothing when the claim finds a live lease or a terminal saga', async () => {
    const { useCase, inventory, payment, writer, sagas } = build([null]);

    await useCase.execute(ORDER_ID);

    expect(sagas.claim).toHaveBeenCalledWith(ORDER_ID, settings.leaseMs);
    expect(inventory.commit).not.toHaveBeenCalled();
    expect(payment.capture).not.toHaveBeenCalled();
    expect(writer.applyLeased).not.toHaveBeenCalled();
  });

  it('commits, then captures, renewing the lease before each call and claiming again between steps', async () => {
    const { useCase, log, applied, metrics } = build([claimed(COMMITTING_STOCK), claimed(CAPTURING)]);

    await useCase.execute(ORDER_ID);

    expect(log).toEqual([
      'claim',
      'renew',
      'commit',
      `apply ${CAPTURING}`,
      'claim',
      'renew',
      'capture',
      `apply ${COMPLETED}`,
    ]);
    expect(applied()[0].lease.version).toBe(11);
    expect(applied()[1].transition.order).toEqual({ status: 'PAID', reason: 'payment:captured' });
    expect(metrics.recordSagaStep.mock.calls).toEqual([
      ['commit_stock', 'success'],
      ['capture', 'success'],
    ]);
  });

  it('stops before the participant once a renew finds another write got there first', async () => {
    const { useCase, sagas, payment, writer } = build([claimed(CAPTURING)]);
    sagas.renew.mockResolvedValueOnce(null);

    await useCase.execute(ORDER_ID);

    expect(payment.capture).not.toHaveBeenCalled();
    expect(writer.applyLeased).not.toHaveBeenCalled();
  });

  it('stops without claiming again once its apply loses to another write', async () => {
    const { useCase, writer, sagas } = build([claimed(COMMITTING_STOCK), claimed(CAPTURING)]);
    writer.applyLeased.mockResolvedValueOnce(false);

    await useCase.execute(ORDER_ID);

    expect(sagas.claim).toHaveBeenCalledTimes(1);
  });

  it('fails the order and voids the money when the commit is refused', async () => {
    const { useCase, inventory, applied, metrics } = build([claimed(COMMITTING_STOCK), null]);
    inventory.commit.mockResolvedValueOnce('CONFLICT' as never);

    await useCase.execute(ORDER_ID);

    expect(applied()[0].transition).toMatchObject({ step: COMPENSATING, pendingCompensations: [CANCEL_PAYMENT] });
    expect(metrics.recordSagaStep).toHaveBeenCalledWith('commit_stock', 'failed');
  });

  it('fails the order, restocks and voids when the money cannot be captured', async () => {
    const { useCase, payment, applied } = build([claimed(CAPTURING), null]);
    payment.capture.mockResolvedValueOnce('NOT_CAPTURABLE' as never);

    await useCase.execute(ORDER_ID);

    expect(applied()[0].transition).toMatchObject({
      step: COMPENSATING,
      pendingCompensations: [RESTOCK, CANCEL_PAYMENT],
      order: { status: 'FAILED' },
    });
  });

  it('backs off on a capture with no answer and never starts a compensation for it', async () => {
    const { useCase, payment, applied, sagas, metrics } = build([claimed(CAPTURING)]);
    payment.capture.mockRejectedValueOnce(new Error('gateway timeout'));

    await useCase.execute(ORDER_ID);

    expect(applied()).toHaveLength(1);
    expect(applied()[0].transition).toMatchObject({
      step: CAPTURING,
      wake: 'backoff',
      pendingCompensations: [],
      cause: null,
      lastError: 'Error: gateway timeout',
    });
    expect(sagas.claim).toHaveBeenCalledTimes(1);
    expect(metrics.recordSagaStep).toHaveBeenCalledWith('capture', 'failed');
  });

  it('rejects a Try abandoned mid-flight and releases its stock in the same advance', async () => {
    const { useCase, log, applied, metrics } = build([claimed(RESERVING), claimed(COMPENSATING, [RELEASE_STOCK])]);

    await useCase.execute(ORDER_ID);

    expect(metrics.recordSagaStep).toHaveBeenCalledWith('try_reserve', 'failed');
    expect(applied()[0].transition).toMatchObject({
      step: COMPENSATING,
      pendingCompensations: [RELEASE_STOCK],
      order: { status: 'REJECTED', reason: 'try:abandoned' },
    });
    expect(log).toEqual(['claim', `apply ${COMPENSATING}`, 'claim', 'renew', 'release', `apply ${COMPENSATED}`]);
  });

  describe('a saga parked on the authorization', () => {
    const graceEnds = deadlineAt.getTime() + graceMs;

    it('stays parked one second before the grace runs out', async () => {
      vi.setSystemTime(graceEnds - 1_000);
      const { useCase, applied, sagas } = build([claimed(AWAITING_AUTH)]);

      await useCase.execute(ORDER_ID);

      expect(applied()[0].transition).toMatchObject({ step: AWAITING_AUTH, wake: 'park', order: null });
      expect(sagas.claim).toHaveBeenCalledTimes(1);
    });

    it('expires exactly when the grace runs out, releasing stock and closing the session', async () => {
      vi.setSystemTime(graceEnds);
      const { useCase, applied } = build([claimed(AWAITING_AUTH), null]);

      await useCase.execute(ORDER_ID);

      expect(applied()[0].transition).toMatchObject({
        step: COMPENSATING,
        pendingCompensations: [RELEASE_STOCK, CANCEL_PAYMENT],
        order: { status: 'EXPIRED' },
      });
    });
  });

  describe('compensating', () => {
    it('runs every compensation, renewing before each, and completes once all are done', async () => {
      const { useCase, log, applied } = build([claimed(COMPENSATING, [RELEASE_STOCK, CANCEL_PAYMENT])]);

      await useCase.execute(ORDER_ID);

      expect(log).toEqual(['claim', 'renew', 'release', 'renew', 'cancel', `apply ${COMPENSATED}`]);
      expect(applied()[0].transition.wake).toBe('done');
    });

    it('still releases the stock when the void has no answer, keeping only the void', async () => {
      const { useCase, payment, applied, inventory } = build([claimed(COMPENSATING, [RELEASE_STOCK, CANCEL_PAYMENT])]);
      payment.cancel.mockRejectedValueOnce(new Error('gateway unavailable'));

      await useCase.execute(ORDER_ID);

      expect(inventory.release).toHaveBeenCalledOnce();
      expect(applied()[0].transition).toMatchObject({
        step: COMPENSATING,
        pendingCompensations: [CANCEL_PAYMENT],
        wake: 'backoff',
        lastError: 'CANCEL_PAYMENT: Error: gateway unavailable',
      });
    });

    it('keeps compensating and records a conflict for someone to look at', async () => {
      const { useCase, payment, inventory, applied, logError } = build([
        claimed(COMPENSATING, [RESTOCK, CANCEL_PAYMENT]),
      ]);
      inventory.restock.mockResolvedValueOnce('CONFLICT' as never);
      payment.cancel.mockResolvedValueOnce('CAPTURED_CONFLICT' as never);

      await useCase.execute(ORDER_ID);

      expect(applied()[0].transition).toMatchObject({
        step: COMPENSATING,
        pendingCompensations: [RESTOCK, CANCEL_PAYMENT],
        lastError: 'RESTOCK: CONFLICT; CANCEL_PAYMENT: CAPTURED_CONFLICT',
      });
      expect(logError).toHaveBeenCalledTimes(2);
    });

    it.each([
      [RELEASE_STOCK, 'RELEASED', COMPENSATED],
      [RELEASE_STOCK, 'FENCED', COMPENSATED],
      [RELEASE_STOCK, 'CONFLICT', COMPENSATING],
      [RESTOCK, 'RESTOCKED', COMPENSATED],
      [RESTOCK, 'CONFLICT', COMPENSATING],
      [CANCEL_PAYMENT, 'CANCELLED', COMPENSATED],
      [CANCEL_PAYMENT, 'FENCED', COMPENSATED],
      [CANCEL_PAYMENT, 'CAPTURED_CONFLICT', COMPENSATING],
    ] as const)('%s answered %s leaves the saga %s', async (compensation, outcome, step) => {
      const { useCase, inventory, payment, applied, metrics } = build([claimed(COMPENSATING, [compensation])]);
      inventory.release.mockResolvedValue(outcome as never);
      inventory.restock.mockResolvedValue(outcome as never);
      payment.cancel.mockResolvedValue(outcome as never);

      await useCase.execute(ORDER_ID);

      expect(applied()[0].transition.step).toBe(step);
      expect(metrics.recordSagaStep).toHaveBeenCalledWith('compensate', step === COMPENSATED ? 'success' : 'failed');
    });

    it('stops mid-pass when a renew loses, writing nothing', async () => {
      const { useCase, sagas, payment, writer } = build([claimed(COMPENSATING, [RELEASE_STOCK, CANCEL_PAYMENT])]);
      sagas.renew.mockResolvedValueOnce(11).mockResolvedValueOnce(null);

      await useCase.execute(ORDER_ID);

      expect(payment.cancel).not.toHaveBeenCalled();
      expect(writer.applyLeased).not.toHaveBeenCalled();
    });
  });

  it('never claims a terminal step again', async () => {
    const { useCase, sagas } = build([claimed(COMPENSATING, []), claimed(COMPENSATED)]);

    await useCase.execute(ORDER_ID);

    expect(sagas.claim).toHaveBeenCalledTimes(1);
  });
});
