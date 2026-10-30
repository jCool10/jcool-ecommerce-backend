import { ApplicationFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';
import type { PinoLogger } from 'nestjs-pino';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import type { OrderInventoryParticipantPort } from '../../application/ports/order-inventory-participant.port';
import type {
  OrderPaymentParticipantPort,
  OrderPaymentStatus,
} from '../../application/ports/order-payment-participant.port';
import type { OrderRepositoryPort } from '../../application/ports/order-repository.port';
import { OrderItem } from '../../domain/order-item.entity';
import { OrderStatus } from '../../domain/order-status';
import { Order } from '../../domain/order.entity';
import { CheckoutSagaActivities } from './checkout-saga.activities';

const ORDER_ID = 'order-1';

describe('CheckoutSagaActivities', () => {
  const build = () => {
    const orders = {
      applyTryResult: vi.fn<OrderRepositoryPort['applyTryResult']>(),
      applyOrderChange: vi.fn<OrderRepositoryPort['applyOrderChange']>(),
      findById: vi.fn<OrderRepositoryPort['findById']>(),
    };
    const inventory = {
      tryReserve: vi.fn<OrderInventoryParticipantPort['tryReserve']>(),
      commit: vi.fn<OrderInventoryParticipantPort['commit']>(),
      release: vi.fn<OrderInventoryParticipantPort['release']>(),
      restock: vi.fn<OrderInventoryParticipantPort['restock']>(),
      statusOf: vi.fn<OrderInventoryParticipantPort['statusOf']>(),
    };
    const payment = {
      openSession: vi.fn<OrderPaymentParticipantPort['openSession']>(),
      capture: vi.fn<OrderPaymentParticipantPort['capture']>(),
      cancel: vi.fn<OrderPaymentParticipantPort['cancel']>(),
      statusOf: vi.fn<OrderPaymentParticipantPort['statusOf']>(),
    };
    const logger = { setContext: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const metrics = fakeMetricsPort();
    const activities = new CheckoutSagaActivities(
      orders as unknown as OrderRepositoryPort,
      inventory,
      payment,
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

  it('Tries with the hold deadline as a Date and hands the outcome back untouched', async () => {
    const { activities, inventory, env, signal } = build();
    inventory.tryReserve.mockResolvedValue('CONTENDED');
    const lines = [{ skuId: 'sku-1', quantity: 2 }];

    const outcome = await env.run(activities.tryReserve, {
      orderId: ORDER_ID,
      lines,
      holdUntil: '2026-10-21T10:00:00.000Z',
    });

    expect(outcome).toBe('CONTENDED');
    expect(inventory.tryReserve).toHaveBeenCalledWith(
      { orderId: ORDER_ID, lines, holdUntil: new Date('2026-10-21T10:00:00.000Z') },
      signal,
    );
  });

  it.each(['applied', 'already', 'stale'] as const)('answers the repository result %s as is', async (result) => {
    const { activities, orders, env } = build();
    orders.applyTryResult.mockResolvedValue(result);
    orders.applyOrderChange.mockResolvedValue(result);
    const change = { orderId: ORDER_ID, from: [OrderStatus.PENDING], to: OrderStatus.CONFIRMING, reason: null };

    await expect(
      env.run(activities.applyTryResult, { orderId: ORDER_ID, outcome: 'HELD' as const, reason: null }),
    ).resolves.toBe(result);
    await expect(env.run(activities.applyOrderChange, change)).resolves.toBe(result);
    expect(orders.applyOrderChange).toHaveBeenCalledWith(change);
  });

  it('returns a commit CONFLICT for the saga to compensate', async () => {
    const { activities, inventory, env, signal } = build();
    inventory.commit.mockResolvedValue('CONFLICT');

    await expect(env.run(activities.commitStock, { orderId: ORDER_ID })).resolves.toBe('CONFLICT');
    expect(inventory.commit).toHaveBeenCalledWith(ORDER_ID, signal);
  });

  it.each(['CAPTURED', 'IDEMPOTENT', 'NOT_CAPTURABLE'] as const)('returns a %s capture', async (outcome) => {
    const { activities, payment, env, signal } = build();
    payment.capture.mockResolvedValue(outcome);

    await expect(env.run(activities.capturePayment, { orderId: ORDER_ID })).resolves.toBe(outcome);
    expect(payment.capture).toHaveBeenCalledWith(ORDER_ID, signal);
  });

  it('throws a capture CONFLICT as retryable and logs it: the saga called out of order', async () => {
    const { activities, payment, logger, env } = build();
    payment.capture.mockResolvedValue('CONFLICT');

    const failure = await env.run(activities.capturePayment, { orderId: ORDER_ID }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure).toMatchObject({ nonRetryable: false });
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ orderId: ORDER_ID }), expect.any(String));
  });

  it.each([
    ['releaseStock', 'release', 'APPLIED'],
    ['releaseStock', 'release', 'IDEMPOTENT'],
    ['restock', 'restock', 'APPLIED'],
    ['restock', 'restock', 'IDEMPOTENT'],
  ] as const)('lands %s on a %s %s', async (activity, method, outcome) => {
    const { activities, inventory, env, signal } = build();
    inventory[method].mockResolvedValue(outcome);

    await expect(env.run(activities[activity], { orderId: ORDER_ID, reason: 'EXPIRED' })).resolves.toBeUndefined();
    expect(inventory[method]).toHaveBeenCalledWith(ORDER_ID, signal);
  });

  it.each(['CANCELLED', 'FENCED', 'IDEMPOTENT'] as const)('lands cancelPayment on %s', async (outcome) => {
    const { activities, payment, env, signal } = build();
    payment.cancel.mockResolvedValue(outcome);

    await expect(
      env.run(activities.cancelPayment, { orderId: ORDER_ID, reason: 'CANCELLED' }),
    ).resolves.toBeUndefined();
    expect(payment.cancel).toHaveBeenCalledWith(ORDER_ID, signal);
  });

  it.each(['releaseStock', 'restock', 'cancelPayment'] as const)(
    'keeps retrying %s on a conflict, logging it with the reason',
    async (activity) => {
      const { activities, inventory, payment, logger, env } = build();
      inventory.release.mockResolvedValue('CONFLICT');
      inventory.restock.mockResolvedValue('CONFLICT');
      payment.cancel.mockResolvedValue('CAPTURED_CONFLICT');

      const failure = await env
        .run(activities[activity], { orderId: ORDER_ID, reason: 'CAPTURE_FAILED' })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ApplicationFailure);
      expect(failure).toMatchObject({ nonRetryable: false });
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: ORDER_ID, reason: 'CAPTURE_FAILED' }),
        expect.any(String),
      );
    },
  );

  it('lets a transient fault through for Temporal to retry', async () => {
    const { activities, inventory, env } = build();
    const fault = new Error('lock timeout');
    inventory.release.mockRejectedValue(fault);

    await expect(env.run(activities.releaseStock, { orderId: ORDER_ID, reason: 'EXPIRED' })).rejects.toBe(fault);
  });

  it('calls the port as it is at call time, so a patched method takes effect', async () => {
    const { activities, inventory, env } = build();
    inventory.commit = vi.fn<OrderInventoryParticipantPort['commit']>().mockResolvedValue('IDEMPOTENT');

    await expect(env.run(activities.commitStock, { orderId: ORDER_ID })).resolves.toBe('IDEMPOTENT');
  });

  it('reads the order status for a late authorization, null when there is no order', async () => {
    const { activities, orders, env } = build();
    const order = Order.rehydrate({
      id: ORDER_ID,
      userId: 'u-1',
      status: OrderStatus.PAID,
      currency: 'VND',
      items: [OrderItem.of('sku-1', 'Widget', 1_000, 1)],
      totalAmountMinor: 1_000,
      placedAt: new Date(),
    });
    orders.findById.mockResolvedValueOnce(order).mockResolvedValueOnce(null);

    await expect(env.run(activities.loadLateAuthorizationContext, { orderId: ORDER_ID })).resolves.toBe(
      OrderStatus.PAID,
    );
    await expect(env.run(activities.loadLateAuthorizationContext, { orderId: ORDER_ID })).resolves.toBeNull();
  });

  describe('metrics', () => {
    const TRY = { orderId: ORDER_ID, lines: [{ skuId: 'sku-1', quantity: 1 }], holdUntil: '2026-10-21T10:00:00.000Z' };

    it.each([
      ['RESERVED', 'reserved'],
      ['OUT_OF_STOCK', 'out_of_stock'],
      ['CONTENDED', 'contended'],
      ['CONFLICT', 'conflict'],
    ] as const)('counts a %s Try as try_reserve/%s', async (outcome, label) => {
      const { activities, inventory, metrics, env } = build();
      inventory.tryReserve.mockResolvedValue(outcome);

      await env.run(activities.tryReserve, TRY);

      expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('try_reserve', label);
    });

    it('counts commit and capture by the answer they got', async () => {
      const { activities, inventory, payment, metrics, env } = build();
      inventory.commit.mockResolvedValue('IDEMPOTENT');
      payment.capture.mockResolvedValue('NOT_CAPTURABLE');

      await env.run(activities.commitStock, { orderId: ORDER_ID });
      await env.run(activities.capturePayment, { orderId: ORDER_ID });

      expect(metrics.recordSagaStep.mock.calls).toEqual([
        ['commit_stock', 'idempotent'],
        ['capture_payment', 'not_capturable'],
      ]);
    });

    it('counts a capture CONFLICT before throwing it', async () => {
      const { activities, payment, metrics, env } = build();
      payment.capture.mockResolvedValue('CONFLICT');

      await env.run(activities.capturePayment, { orderId: ORDER_ID }).catch(() => undefined);

      expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('capture_payment', 'conflict');
    });

    it('counts a call that threw as error and still throws it', async () => {
      const { activities, inventory, metrics, env } = build();
      const fault = new Error('lock timeout');
      inventory.tryReserve.mockRejectedValue(fault);
      inventory.commit.mockRejectedValue(fault);

      await expect(env.run(activities.tryReserve, TRY)).rejects.toBe(fault);
      await expect(env.run(activities.commitStock, { orderId: ORDER_ID })).rejects.toBe(fault);

      expect(metrics.recordSagaStep.mock.calls).toEqual([
        ['try_reserve', 'error'],
        ['commit_stock', 'error'],
      ]);
      expect(metrics.recordCompensation).not.toHaveBeenCalled();
    });

    it.each([
      ['releaseStock', 'release', 'release_stock'],
      ['restock', 'restock', 'restock'],
    ] as const)('counts %s as a compensation only when it applied', async (activity, method, kind) => {
      const { activities, inventory, metrics, env } = build();
      inventory[method].mockResolvedValueOnce('APPLIED').mockResolvedValueOnce('IDEMPOTENT');

      await env.run(activities[activity], { orderId: ORDER_ID, reason: 'TRY_TIMEOUT' });
      await env.run(activities[activity], { orderId: ORDER_ID, reason: 'TRY_TIMEOUT' });

      expect(metrics.recordSagaStep.mock.calls).toEqual([
        [kind, 'applied'],
        [kind, 'idempotent'],
      ]);
      expect(metrics.recordCompensation).toHaveBeenCalledExactlyOnceWith(kind, 'try_timeout');
    });

    it.each(['CANCELLED', 'FENCED'] as const)('counts a %s payment cancel as a compensation', async (outcome) => {
      const { activities, payment, metrics, env } = build();
      payment.cancel.mockResolvedValue(outcome);

      await env.run(activities.cancelPayment, { orderId: ORDER_ID, reason: 'LATE_AUTHORIZATION' });

      expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('cancel_payment', outcome.toLowerCase());
      expect(metrics.recordCompensation).toHaveBeenCalledExactlyOnceWith('cancel_payment', 'late_authorization');
    });

    it('does not count a payment cancel that found its work done', async () => {
      const { activities, payment, metrics, env } = build();
      payment.cancel.mockResolvedValue('IDEMPOTENT');

      await env.run(activities.cancelPayment, { orderId: ORDER_ID, reason: 'CANCELLED' });

      expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('cancel_payment', 'idempotent');
      expect(metrics.recordCompensation).not.toHaveBeenCalled();
    });

    it.each([
      ['releaseStock', 'release_stock', 'conflict'],
      ['restock', 'restock', 'conflict'],
      ['cancelPayment', 'cancel_payment', 'captured_conflict'],
    ] as const)('counts a %s conflict as a step outcome, not a compensation', async (activity, step, label) => {
      const { activities, inventory, payment, metrics, env } = build();
      inventory.release.mockResolvedValue('CONFLICT');
      inventory.restock.mockResolvedValue('CONFLICT');
      payment.cancel.mockResolvedValue('CAPTURED_CONFLICT');

      await env.run(activities[activity], { orderId: ORDER_ID, reason: 'EXPIRED' }).catch(() => undefined);

      expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith(step, label);
      expect(metrics.recordCompensation).not.toHaveBeenCalled();
    });

    it('leaves the order writes and the authorization check uncounted', async () => {
      const { activities, orders, payment, metrics, env } = build();
      orders.applyTryResult.mockResolvedValue('applied');
      orders.applyOrderChange.mockResolvedValue('applied');
      payment.statusOf.mockResolvedValue(new Map());

      await env.run(activities.applyTryResult, { orderId: ORDER_ID, outcome: 'HELD' as const, reason: null });
      await env.run(activities.applyOrderChange, {
        orderId: ORDER_ID,
        from: [OrderStatus.PENDING],
        to: OrderStatus.CONFIRMING,
        reason: null,
      });
      await env.run(activities.verifyAuthorization, { orderId: ORDER_ID, paymentId: 'pay-1' });

      expect(metrics.recordSagaStep).not.toHaveBeenCalled();
    });
  });

  describe('verifyAuthorization', () => {
    const status = (overrides: Partial<OrderPaymentStatus>): OrderPaymentStatus => ({
      header: 'AUTHORIZED',
      authorizedPaymentId: 'pay-1',
      hasAuthorizedAttempt: true,
      hasSucceededAttempt: false,
      ...overrides,
    });

    it('verifies an AUTHORIZED header holding the signalled payment', async () => {
      const { activities, payment, env, signal } = build();
      payment.statusOf.mockResolvedValue(new Map([[ORDER_ID, status({})]]));

      await expect(env.run(activities.verifyAuthorization, { orderId: ORDER_ID, paymentId: 'pay-1' })).resolves.toBe(
        'VERIFIED',
      );
      expect(payment.statusOf).toHaveBeenCalledWith([ORDER_ID], signal);
    });

    it.each(['OPEN', 'CAPTURED', 'CANCELLED', 'FENCED', null] as const)(
      'refuses a %s header as not authorized',
      async (header) => {
        const { activities, payment, env } = build();
        payment.statusOf.mockResolvedValue(new Map([[ORDER_ID, status({ header })]]));

        await expect(env.run(activities.verifyAuthorization, { orderId: ORDER_ID, paymentId: 'pay-1' })).resolves.toBe(
          'NOT_AUTHORIZED',
        );
      },
    );

    it('refuses an order payment never answered for as not authorized', async () => {
      const { activities, payment, env } = build();
      payment.statusOf.mockResolvedValue(new Map());

      await expect(env.run(activities.verifyAuthorization, { orderId: ORDER_ID, paymentId: 'pay-1' })).resolves.toBe(
        'NOT_AUTHORIZED',
      );
    });

    it('flags an authorization held by another payment', async () => {
      const { activities, payment, env } = build();
      payment.statusOf.mockResolvedValue(new Map([[ORDER_ID, status({ authorizedPaymentId: 'pay-2' })]]));

      await expect(env.run(activities.verifyAuthorization, { orderId: ORDER_ID, paymentId: 'pay-1' })).resolves.toBe(
        'PAYMENT_MISMATCH',
      );
    });

    it('throws when payment cannot answer', async () => {
      const { activities, payment, env } = build();
      const fault = new Error('payment db down');
      payment.statusOf.mockRejectedValue(fault);

      await expect(env.run(activities.verifyAuthorization, { orderId: ORDER_ID, paymentId: 'pay-1' })).rejects.toBe(
        fault,
      );
    });
  });
});
