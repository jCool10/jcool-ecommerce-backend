import { ApplicationFailure } from '@temporalio/common';
import { describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { Order } from '../../domain/order.entity';
import { OrderItem } from '../../domain/order-item.entity';
import { OrderStatus } from '../../domain/order-status';
import type { IdempotencyStorePort } from '../../application/ports/idempotency-store.port';
import type { InventoryTccPort } from '../../application/ports/inventory-participant.port';
import type { OrderRepositoryPort } from '../../application/ports/order-repository.port';
import type { PaymentTccPort } from '../../application/ports/payment-participant.port';
import {
  SagaOrderMissingError,
  type CheckoutOrderWriter,
  type OrderWrite,
  type OrderWriteOutcome,
} from '../../application/saga/checkout-order.writer';
import { createCheckoutSagaActivities, type OrderChangeInput } from './checkout-saga.activities';

const ORDER_ID = '900001';
const TX = { tx: true } as unknown as DrizzleTx;
const IDEMPOTENCY = { scope: 'user:u1', key: 'key-1' };

const placed = Order.rehydrate({
  id: ORDER_ID,
  userId: 'u1',
  status: OrderStatus.PENDING,
  currency: 'VND',
  items: [OrderItem.of('sku-1', 'Widget', 120_000, 2)],
  totalAmountMinor: 240_000,
  placedAt: new Date('2026-03-01T09:00:00.000Z'),
  paymentDeadlineAt: new Date('2026-03-01T10:00:00.000Z'),
});

const HELD_INPUT = {
  orderId: ORDER_ID,
  from: OrderStatus.RESERVING,
  change: { status: OrderStatus.PENDING },
  cause: null,
  verdict: 'HELD',
  idempotency: IDEMPOTENCY,
} as const;

const EXPIRE_INPUT: OrderChangeInput = {
  orderId: ORDER_ID,
  from: OrderStatus.PENDING,
  change: { status: OrderStatus.EXPIRED, reason: 'saga:deadline' },
  cause: 'expired',
};

function build(outcome: OrderWriteOutcome = 'written') {
  const writer = {
    apply: vi.fn(async ({ inTx }: OrderWrite) => {
      if (outcome === 'written') await inTx?.(TX, placed);
      return outcome;
    }),
  };
  const inventory = {
    tryReserve: vi.fn<InventoryTccPort['tryReserve']>(() => Promise.resolve('HELD')),
    commit: vi.fn<InventoryTccPort['commit']>(() => Promise.resolve('COMMITTED')),
    release: vi.fn<InventoryTccPort['release']>(() => Promise.resolve('RELEASED')),
    restock: vi.fn<InventoryTccPort['restock']>(() => Promise.resolve('RESTOCKED')),
  };
  const payment = {
    capture: vi.fn<PaymentTccPort['capture']>(() => Promise.resolve('CAPTURED')),
    cancel: vi.fn<PaymentTccPort['cancel']>(() => Promise.resolve('CANCELLED')),
  };
  const orders = { findById: vi.fn<OrderRepositoryPort['findById']>(() => Promise.resolve(placed)) };
  const idempotencyStore = { markCompleted: vi.fn(() => Promise.resolve()) };
  const metrics = fakeMetricsPort();
  const logError = vi.fn();
  const activities = createCheckoutSagaActivities({
    inventory: inventory,
    payment: payment as unknown as PaymentTccPort,
    writer: writer as unknown as CheckoutOrderWriter,
    orders: orders as unknown as OrderRepositoryPort,
    idempotencyStore: idempotencyStore as unknown as IdempotencyStorePort,
    metrics,
    logger: fakePinoLogger({ error: logError }),
  });
  return { activities, writer, inventory, payment, orders, idempotencyStore, metrics, logError };
}

const failureOf = (promise: Promise<unknown>): Promise<ApplicationFailure> =>
  promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(ApplicationFailure);
      return error as ApplicationFailure;
    },
  );

describe('checkout saga activities', () => {
  describe('applyTryResult', () => {
    it('places the order from RESERVING and completes the key with the placed view in the same tx', async () => {
      const { activities, writer, idempotencyStore, metrics } = build();

      await expect(activities.applyTryResult(HELD_INPUT)).resolves.toBe('applied');

      expect(writer.apply).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: ORDER_ID, from: OrderStatus.RESERVING, change: { status: 'PENDING' } }),
      );
      expect(idempotencyStore.markCompleted).toHaveBeenCalledExactlyOnceWith(
        {
          ...IDEMPOTENCY,
          orderId: ORDER_ID,
          responseStatus: 201,
          responseBody: expect.objectContaining({ id: ORDER_ID, status: OrderStatus.PENDING }) as unknown,
        },
        TX,
      );
      expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('try_reserve', 'success');
    });

    it('leaves the key alone on a refusal, which the writer frees with the rejection', async () => {
      const { activities, idempotencyStore, metrics } = build();

      await activities.applyTryResult({
        ...HELD_INPUT,
        verdict: 'OUT_OF_STOCK',
        change: { status: OrderStatus.REJECTED, reason: 'try:out_of_stock' },
      });

      expect(idempotencyStore.markCompleted).not.toHaveBeenCalled();
      expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('try_reserve', 'failed');
    });

    it('counts nothing when an earlier attempt already wrote the result', async () => {
      const { activities, idempotencyStore, metrics } = build('already');

      await expect(activities.applyTryResult(HELD_INPUT)).resolves.toBe('applied');

      expect(idempotencyStore.markCompleted).not.toHaveBeenCalled();
      expect(metrics.recordSagaStep).not.toHaveBeenCalled();
    });

    it('reports an order that moved elsewhere as stale', async () => {
      const { activities } = build('stale');

      await expect(activities.applyTryResult(HELD_INPUT)).resolves.toBe('stale');
    });
  });

  describe('applyOrderChange', () => {
    it('counts the compensation cause once the change is written', async () => {
      const { activities, metrics } = build();

      await expect(activities.applyOrderChange(EXPIRE_INPUT)).resolves.toBe('applied');

      expect(metrics.recordCompensation).toHaveBeenCalledExactlyOnceWith('expired');
    });

    it('does not count a cause twice for a retried write', async () => {
      const { activities, metrics } = build('already');

      await activities.applyOrderChange(EXPIRE_INPUT);

      expect(metrics.recordCompensation).not.toHaveBeenCalled();
    });

    it('fails for good on an order that does not exist', async () => {
      const { activities, writer } = build();
      writer.apply.mockRejectedValueOnce(new SagaOrderMissingError(ORDER_ID));

      const failure = await failureOf(activities.applyOrderChange(EXPIRE_INPUT));

      expect(failure.nonRetryable).toBe(true);
      expect(failure.type).toBe('SagaOrderMissingError');
    });

    it('retries a database failure, carrying only its name and a bounded message', async () => {
      const { activities, writer } = build();
      writer.apply.mockRejectedValueOnce(Object.assign(new Error('x'.repeat(2_000)), { name: 'DatabaseError' }));

      const failure = await failureOf(activities.applyOrderChange(EXPIRE_INPUT));

      expect(failure.nonRetryable).toBe(false);
      expect(failure.type).toBe('DatabaseError');
      expect(failure.message.length).toBe(500);
      expect(failure.message.startsWith('DatabaseError: ')).toBe(true);
    });
  });

  it('asks inventory for the hold with its expiry as a Date', async () => {
    const { activities, inventory } = build();

    await activities.tryReserve({
      orderId: ORDER_ID,
      lines: [{ skuId: 'sku-1', quantity: 2 }],
      holdUntil: '2026-03-01T11:00:00.000Z',
    });

    expect(inventory.tryReserve).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      lines: [{ skuId: 'sku-1', quantity: 2 }],
      holdUntil: new Date('2026-03-01T11:00:00.000Z'),
    });
  });

  it.each([
    ['commitStock', 'commit_stock', 'COMMITTED', 'CONFLICT'],
    ['capturePayment', 'capture', 'CAPTURED', 'NOT_CAPTURABLE'],
  ] as const)('returns the %s outcome and counts it', async (name, metric, good, bad) => {
    const { activities, inventory, payment, metrics } = build();
    (name === 'commitStock' ? inventory.commit : payment.capture).mockResolvedValueOnce(bad as never);

    await expect(activities[name](ORDER_ID)).resolves.toBe(bad);
    await expect(activities[name](ORDER_ID)).resolves.toBe(good);

    expect(metrics.recordSagaStep.mock.calls).toEqual([
      [metric, 'failed'],
      [metric, 'success'],
    ]);
  });

  it('turns a participant that could not answer into a retry', async () => {
    const { activities, payment, metrics } = build();
    payment.capture.mockRejectedValueOnce(new Error('gateway timeout'));

    const failure = await failureOf(activities.capturePayment(ORDER_ID));

    expect(failure.nonRetryable).toBe(false);
    expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('capture', 'failed');
  });

  it.each([
    ['releaseStock', 'release', 'FENCED'],
    ['restock', 'restock', 'RESTOCKED'],
    ['cancelPayment', 'cancel', 'CANCELLED'],
  ] as const)('settles %s on a participant outcome that undoes it', async (name, call, outcome) => {
    const { activities, inventory, payment, metrics } = build();
    const port = call === 'cancel' ? payment : inventory;
    (port[call as keyof typeof port] as ReturnType<typeof vi.fn>).mockResolvedValueOnce(outcome);

    await expect(activities[name](ORDER_ID)).resolves.toBeUndefined();

    expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('compensate', 'success');
  });

  // Nothing the saga does resolves a conflict; it keeps retrying, loudly, until a person does.
  it.each([
    ['releaseStock', 'release', 'CONFLICT'],
    ['cancelPayment', 'cancel', 'CAPTURED_CONFLICT'],
  ] as const)('keeps %s retrying on %s and logs it', async (name, call, outcome) => {
    const { activities, inventory, payment, logError } = build();
    const port = call === 'cancel' ? payment : inventory;
    (port[call as keyof typeof port] as ReturnType<typeof vi.fn>).mockResolvedValueOnce(outcome);

    const failure = await failureOf(activities[name](ORDER_ID));

    expect(failure.nonRetryable).toBe(false);
    expect(failure.type).toBe(outcome);
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ orderId: ORDER_ID, outcome }), expect.any(String));
  });

  it('reads the order status for a late authorization, or null when the order is gone', async () => {
    const { activities, orders } = build();

    await expect(activities.loadLateAuthorizationContext(ORDER_ID)).resolves.toEqual({ status: OrderStatus.PENDING });
    orders.findById.mockResolvedValueOnce(null);
    await expect(activities.loadLateAuthorizationContext(ORDER_ID)).resolves.toEqual({ status: null });
  });

  it('records a compensation cause on its own', async () => {
    const { activities, metrics } = build();

    await activities.recordCompensation('late_authorization');

    expect(metrics.recordCompensation).toHaveBeenCalledExactlyOnceWith('late_authorization');
  });
});
