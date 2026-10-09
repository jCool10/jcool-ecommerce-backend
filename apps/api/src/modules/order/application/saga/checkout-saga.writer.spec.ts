import { describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { CheckoutSagaStep, Compensation } from '../../domain/checkout-saga-step';
import {
  onAuthorized,
  onCaptureResult,
  onCommitResult,
  onStepFailed,
  onTryResult,
  type SagaTransition,
} from '../../domain/checkout-saga';
import { Order } from '../../domain/order.entity';
import { OrderItem } from '../../domain/order-item.entity';
import { OrderStatus } from '../../domain/order-status';
import type { CheckoutSaga, CheckoutSagaRepositoryPort } from '../ports/checkout-saga-repository.port';
import type { OrderRepositoryPort } from '../ports/order-repository.port';
import type { CheckoutSagaSettings } from './checkout-saga.settings';
import { CheckoutSagaWriter } from './checkout-saga.writer';

const tx = { tx: true } as unknown as DrizzleTx;
const now = new Date('2026-03-01T09:00:00.000Z');
const placedAt = new Date('2026-03-01T08:59:59.000Z');
const deadlineAt = new Date('2026-03-01T10:00:00.000Z');
const settings: CheckoutSagaSettings = {
  leaseMs: 60_000,
  timing: { authGraceMs: 180_000, retryBaseMs: 1_000, retryCapMs: 300_000 },
  paymentDeadlineMs: 3_600_000,
  payCutoffMs: 1_980_000,
  tryTimeoutMs: 3_000,
  holdSafetyMs: 3_600_000,
};

const orderIn = (status: OrderStatus): Order =>
  Order.rehydrate({
    id: '900001',
    userId: 'u-1',
    status,
    currency: 'VND',
    items: [OrderItem.of('sku-1', 'Widget', 120_000, 1)],
    totalAmountMinor: 120_000,
    placedAt,
  });

const sagaAt = (step: CheckoutSaga['step'], extra: Partial<CheckoutSaga> = {}): CheckoutSaga => ({
  orderId: '900001',
  step,
  pendingCompensations: [],
  deadlineAt,
  nextAttemptAt: now,
  attempts: 0,
  leaseUntil: new Date(now.getTime() + 60_000),
  lastError: null,
  version: 7,
  ...extra,
});

function build(order: Order | null = null, applied = true) {
  const calls: string[] = [];
  const orders = {
    withTransaction: vi.fn((fn: (t: DrizzleTx) => Promise<unknown>) => fn(tx)),
    findByIdForUpdate: vi.fn(() => {
      calls.push('lock order');
      return Promise.resolve(order);
    }),
    saveStatus: vi.fn().mockResolvedValue(undefined),
    clearIdempotencyKey: vi.fn().mockResolvedValue(undefined),
  };
  const sagas = {
    applyLeased: vi.fn(() => {
      calls.push('apply saga');
      return Promise.resolve(applied);
    }),
    rewrite: vi.fn().mockResolvedValue(undefined),
  };
  const outbox = { append: vi.fn(() => Promise.resolve(undefined)) };
  const ids = {
    mint: vi.fn(() => {
      calls.push('mint');
      return Promise.resolve(['800001']);
    }),
  };
  const metrics = fakeMetricsPort();
  const writer = new CheckoutSagaWriter(
    orders as unknown as OrderRepositoryPort,
    sagas as unknown as CheckoutSagaRepositoryPort,
    outbox,
    ids,
    settings,
    metrics,
  );
  return { writer, orders, sagas, outbox, ids, metrics, calls };
}

describe('CheckoutSagaWriter.applyLeased', () => {
  it('writes a saga-only step without touching the order, releasing the lease under the held version', async () => {
    const { writer, orders, sagas, outbox } = build();

    const applied = await writer.applyLeased(sagaAt(CheckoutSagaStep.COMMITTING_STOCK), onCommitResult('COMMITTED'), {
      now,
    });

    expect(applied).toBe(true);
    expect(orders.findByIdForUpdate).not.toHaveBeenCalled();
    expect(sagas.applyLeased).toHaveBeenCalledWith(tx, '900001', 7, {
      step: CheckoutSagaStep.CAPTURING,
      pendingCompensations: [],
      nextAttemptAt: now,
      attempts: 0,
      lastError: null,
    });
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('parks a held Try until the authorization grace ends, places the order and emits order.placed', async () => {
    const { writer, orders, sagas, outbox, calls } = build(orderIn(OrderStatus.RESERVING));
    const inTx = vi.fn().mockResolvedValue(undefined);

    await writer.applyLeased(sagaAt(CheckoutSagaStep.RESERVING), onTryResult('HELD'), { now, inTx });

    expect(calls).toEqual(['mint', 'lock order', 'apply saga']);
    expect(sagas.applyLeased).toHaveBeenCalledWith(tx, '900001', 7, {
      step: CheckoutSagaStep.AWAITING_AUTH,
      pendingCompensations: [],
      nextAttemptAt: new Date(deadlineAt.getTime() + 180_000),
      attempts: 0,
      lastError: null,
    });
    expect(orders.saveStatus).toHaveBeenCalledWith(expect.objectContaining({ status: OrderStatus.PENDING }), tx);
    expect(outbox.append).toHaveBeenCalledWith(tx, expect.objectContaining({ eventType: 'order.placed' }), '800001');
    expect(inTx).toHaveBeenCalledWith(tx, expect.objectContaining({ status: OrderStatus.PENDING }));
  });

  it('rejects with the clock it was given, frees the idempotency key and emits nothing', async () => {
    const { writer, orders, outbox, ids } = build(orderIn(OrderStatus.RESERVING));

    await writer.applyLeased(sagaAt(CheckoutSagaStep.RESERVING), onTryResult('TIMEOUT'), { now });

    expect(ids.mint).not.toHaveBeenCalled();
    expect(orders.saveStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: OrderStatus.REJECTED, finalizedAt: now, finalizeReason: 'try:timeout' }),
      tx,
    );
    expect(orders.clearIdempotencyKey).toHaveBeenCalledWith('900001', tx);
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('settles a captured order as PAID and emits order.paid', async () => {
    const { writer, orders, outbox } = build(orderIn(OrderStatus.CONFIRMING));

    await writer.applyLeased(sagaAt(CheckoutSagaStep.CAPTURING), onCaptureResult('CAPTURED'), { now });

    expect(orders.saveStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: OrderStatus.PAID, finalizedAt: now, paymentRef: null }),
      tx,
    );
    expect(outbox.append).toHaveBeenCalledWith(tx, expect.objectContaining({ eventType: 'order.paid' }), '800001');
  });

  it('backs off from the attempts already spent', async () => {
    const { writer, sagas } = build();

    await writer.applyLeased(
      sagaAt(CheckoutSagaStep.CAPTURING, { attempts: 2 }),
      onStepFailed(sagaAt(CheckoutSagaStep.CAPTURING), 'timeout'),
      {
        now,
      },
    );

    expect(sagas.applyLeased).toHaveBeenCalledWith(
      tx,
      '900001',
      7,
      expect.objectContaining({
        nextAttemptAt: new Date(now.getTime() + 4_000),
        attempts: 3,
        lastError: 'timeout',
      }),
    );
  });

  it('writes nothing to the order once another write has moved the saga', async () => {
    const { writer, orders, outbox, metrics } = build(orderIn(OrderStatus.CONFIRMING), false);

    const applied = await writer.applyLeased(sagaAt(CheckoutSagaStep.CAPTURING), onCaptureResult('NOT_CAPTURABLE'), {
      now,
    });

    expect(applied).toBe(false);
    expect(orders.saveStatus).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
    expect(metrics.recordCompensation).not.toHaveBeenCalled();
  });

  it('counts a compensation once the transition that starts it has committed', async () => {
    const { writer, metrics } = build(orderIn(OrderStatus.CONFIRMING));

    await writer.applyLeased(sagaAt(CheckoutSagaStep.CAPTURING), onCaptureResult('NOT_CAPTURABLE'), { now });

    expect(metrics.recordCompensation).toHaveBeenCalledWith('capture_failed');
  });
});

describe('CheckoutSagaWriter.rewrite', () => {
  const confirm = (): SagaTransition => {
    const decision = onAuthorized(sagaAt(CheckoutSagaStep.AWAITING_AUTH), true);
    if (decision.kind !== 'apply') throw new Error('expected a transition');
    return decision.transition;
  };

  it('bumps the saga outside any lease, wakes it now and confirms the order without an event', async () => {
    const { writer, orders, sagas, outbox } = build();

    const changed = await writer.rewrite(
      tx,
      orderIn(OrderStatus.PENDING),
      sagaAt(CheckoutSagaStep.AWAITING_AUTH, { attempts: 3 }),
      confirm(),
      {
        now,
        eventId: '800009',
      },
    );

    expect(sagas.rewrite).toHaveBeenCalledWith(tx, '900001', {
      step: CheckoutSagaStep.COMMITTING_STOCK,
      pendingCompensations: [],
      nextAttemptAt: now,
      attempts: 0,
      lastError: null,
    });
    expect(sagas.applyLeased).not.toHaveBeenCalled();
    expect(changed.status).toBe(OrderStatus.CONFIRMING);
    expect(orders.saveStatus).toHaveBeenCalledWith(changed, tx);
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('rewrites the saga even when the order is left alone, as a late authorization does', async () => {
    const { writer, orders, sagas } = build();
    const late = onAuthorized(sagaAt(CheckoutSagaStep.COMPENSATED), true);
    if (late.kind !== 'apply') throw new Error('expected a transition');

    const unchanged = await writer.rewrite(
      tx,
      orderIn(OrderStatus.EXPIRED),
      sagaAt(CheckoutSagaStep.COMPENSATED),
      late.transition,
      {
        now,
      },
    );

    expect(unchanged.status).toBe(OrderStatus.EXPIRED);
    expect(orders.saveStatus).not.toHaveBeenCalled();
    expect(sagas.rewrite).toHaveBeenCalledWith(
      tx,
      '900001',
      expect.objectContaining({
        step: CheckoutSagaStep.COMPENSATING,
        pendingCompensations: [Compensation.CANCEL_PAYMENT],
      }),
    );
  });

  it('emits the settling event under the id minted before the transaction', async () => {
    const { writer, outbox } = build();
    const mismatch = onAuthorized(sagaAt(CheckoutSagaStep.AWAITING_AUTH), false);
    if (mismatch.kind !== 'apply') throw new Error('expected a transition');

    await writer.rewrite(
      tx,
      orderIn(OrderStatus.PENDING),
      sagaAt(CheckoutSagaStep.AWAITING_AUTH),
      mismatch.transition,
      {
        now,
        eventId: '800009',
      },
    );

    expect(outbox.append).toHaveBeenCalledWith(tx, expect.objectContaining({ eventType: 'order.failed' }), '800009');
  });
});
