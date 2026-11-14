import { ApplicationFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';
import type { PinoLogger } from 'nestjs-pino';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import type { OrderInventoryParticipantPort } from '../../application/ports/order-inventory-participant.port';
import type { OrderPaymentParticipantPort } from '../../application/ports/order-payment-participant.port';
import type { OrderRepositoryPort } from '../../application/ports/order-repository.port';
import { OrderItem } from '../../domain/order-item.entity';
import { OrderStatus } from '../../domain/order-status';
import { Order } from '../../domain/order.entity';
import { CheckoutSagaActivities } from './checkout-saga.activities';
import { REFUND_CONFLICT_FAILURE } from './refund-order.contract';
import { RefundOrderActivities } from './refund-order.activities';

const ORDER_ID = '137465797020397179';
const ADMIN_ID = '137465797020397182';

const orderIn = (status: OrderStatus): Order =>
  Order.rehydrate({
    id: ORDER_ID,
    userId: 'u',
    status,
    currency: 'VND',
    items: [OrderItem.of('sku-1', 'Widget', 100_000, 1)],
    totalAmountMinor: 100_000,
    placedAt: new Date('2026-11-01T00:00:00.000Z'),
  });

describe('RefundOrderActivities', () => {
  const build = () => {
    const orders = {
      applyRefundChange: vi.fn<OrderRepositoryPort['applyRefundChange']>(),
      findById: vi.fn<OrderRepositoryPort['findById']>(),
    };
    const inventory = { restock: vi.fn<OrderInventoryParticipantPort['restock']>() };
    const payment = { refund: vi.fn<OrderPaymentParticipantPort['refund']>() };
    const logger = { setContext: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const metrics = fakeMetricsPort();
    const activities = new RefundOrderActivities(
      orders as unknown as OrderRepositoryPort,
      inventory as unknown as OrderInventoryParticipantPort,
      payment as unknown as OrderPaymentParticipantPort,
      metrics,
      logger as unknown as PinoLogger,
    );
    const env = new MockActivityEnvironment();
    return {
      activities,
      orders,
      inventory,
      payment,
      metrics,
      logger,
      env,
      signal: { signal: env.context.cancellationSignal },
    };
  };

  describe('beginRefund', () => {
    it.each([
      ['applied', 'started'],
      ['already', 'resumed'],
    ] as const)('answers a %s PAID → REFUNDING write as %s', async (written, answer) => {
      const { activities, orders, env } = build();
      orders.applyRefundChange.mockResolvedValue(written);

      await expect(env.run(activities.beginRefund, { orderId: ORDER_ID })).resolves.toBe(answer);
      expect(orders.applyRefundChange).toHaveBeenCalledExactlyOnceWith({
        orderId: ORDER_ID,
        from: OrderStatus.PAID,
        to: OrderStatus.REFUNDING,
      });
    });

    it.each([
      [OrderStatus.REFUNDED, 'already_refunded'],
      [OrderStatus.PENDING, 'not_refundable'],
      [OrderStatus.CONFIRMING, 'not_refundable'],
      [OrderStatus.CANCELLED, 'not_refundable'],
    ] as const)('tells a stale write on a %s order apart as %s', async (status, answer) => {
      const { activities, orders, env } = build();
      orders.applyRefundChange.mockResolvedValue('stale');
      orders.findById.mockResolvedValue(orderIn(status));

      await expect(env.run(activities.beginRefund, { orderId: ORDER_ID })).resolves.toBe(answer);
    });

    it('answers not_refundable for an order that does not exist', async () => {
      const { activities, orders, env } = build();
      orders.applyRefundChange.mockResolvedValue('stale');
      orders.findById.mockResolvedValue(null);

      await expect(env.run(activities.beginRefund, { orderId: ORDER_ID })).resolves.toBe('not_refundable');
    });
  });

  describe('refundPayment', () => {
    it.each([
      [{ outcome: 'REFUNDED' as const }, 'refunded'],
      [{ outcome: 'IDEMPOTENT' as const }, 'idempotent'],
      [{ outcome: 'PENDING' as const }, 'refund_pending'],
      [{ outcome: 'REFUND_FAILED' as const, reason: 'charge_disputed' }, 'refund_failed'],
    ] as const)('hands back %o and counts one refund_payment %s', async (answer, label) => {
      const { activities, payment, metrics, env, signal } = build();
      payment.refund.mockResolvedValue(answer);

      await expect(env.run(activities.refundPayment, { orderId: ORDER_ID, requestedBy: ADMIN_ID })).resolves.toEqual(
        answer,
      );
      expect(payment.refund).toHaveBeenCalledExactlyOnceWith(ORDER_ID, ADMIN_ID, signal);
      expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('refund_payment', label);
    });

    // The order is REFUNDING, which only a captured payment lets happen: someone moved the header by hand.
    it('throws NOT_REFUNDABLE as a retryable conflict, counted as one', async () => {
      const { activities, payment, metrics, logger, env } = build();
      payment.refund.mockResolvedValue({ outcome: 'NOT_REFUNDABLE' });

      const failure = await env
        .run(activities.refundPayment, { orderId: ORDER_ID, requestedBy: ADMIN_ID })
        .catch((thrown: unknown) => thrown);

      expect(failure).toBeInstanceOf(ApplicationFailure);
      expect(failure).toMatchObject({ type: REFUND_CONFLICT_FAILURE, nonRetryable: false });
      expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('refund_payment', 'conflict');
      expect(logger.error).toHaveBeenCalledOnce();
    });

    it('counts a call that threw as error and lets it through for the retry', async () => {
      const { activities, payment, metrics, env } = build();
      const outage = new Error('payment-service unavailable');
      payment.refund.mockRejectedValue(outage);

      await expect(env.run(activities.refundPayment, { orderId: ORDER_ID, requestedBy: ADMIN_ID })).rejects.toBe(
        outage,
      );
      expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('refund_payment', 'error');
    });
  });

  describe('restockRefundedOrder', () => {
    it.each([
      ['APPLIED', 'applied'],
      ['IDEMPOTENT', 'idempotent'],
    ] as const)('hands back %s and counts one restock %s', async (outcome, label) => {
      const { activities, inventory, metrics, env, signal } = build();
      inventory.restock.mockResolvedValue(outcome);

      await expect(env.run(activities.restockRefundedOrder, { orderId: ORDER_ID })).resolves.toBe(outcome);
      expect(inventory.restock).toHaveBeenCalledExactlyOnceWith(ORDER_ID, signal);
      expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('restock', label);
      expect(metrics.recordCompensation).not.toHaveBeenCalled();
    });

    it('throws CONFLICT as a retryable conflict, counted as one', async () => {
      const { activities, inventory, metrics, env } = build();
      inventory.restock.mockResolvedValue('CONFLICT');

      await expect(env.run(activities.restockRefundedOrder, { orderId: ORDER_ID })).rejects.toMatchObject({
        type: REFUND_CONFLICT_FAILURE,
        nonRetryable: false,
      });
      expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('restock', 'conflict');
    });
  });

  it('abandons through REFUNDING → PAID and completes through REFUNDING → REFUNDED, recording no step', async () => {
    const { activities, orders, metrics, env } = build();
    orders.applyRefundChange.mockResolvedValue('applied');

    await expect(env.run(activities.abandonRefund, { orderId: ORDER_ID })).resolves.toBe('applied');
    await expect(env.run(activities.completeRefund, { orderId: ORDER_ID, requestedBy: ADMIN_ID })).resolves.toBe(
      'applied',
    );

    expect(orders.applyRefundChange.mock.calls.map(([input]) => input)).toEqual([
      { orderId: ORDER_ID, from: OrderStatus.REFUNDING, to: OrderStatus.PAID },
      { orderId: ORDER_ID, from: OrderStatus.REFUNDING, to: OrderStatus.REFUNDED, requestedBy: ADMIN_ID },
    ]);
    expect(metrics.recordSagaStep).not.toHaveBeenCalled();
  });

  // The worker registers both sets in one map, where a shared name would silently replace one.
  it('exposes the five refund activities as own properties, none named like a checkout one', () => {
    const { activities, logger } = build();
    const namesOf = (instance: object) =>
      Object.entries(instance)
        .filter(([, value]) => typeof value === 'function')
        .map(([key]) => key);
    const checkout = new CheckoutSagaActivities(
      {} as OrderRepositoryPort,
      {} as OrderInventoryParticipantPort,
      {} as OrderPaymentParticipantPort,
      fakeMetricsPort(),
      logger as unknown as PinoLogger,
    );

    expect(namesOf(activities).sort()).toEqual([
      'abandonRefund',
      'beginRefund',
      'completeRefund',
      'refundPayment',
      'restockRefundedOrder',
    ]);
    expect(namesOf(checkout)).not.toHaveLength(0);
    expect(namesOf(checkout).filter((name) => namesOf(activities).includes(name))).toEqual([]);
  });
});
