import { ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { ORDER_STATUSES, OrderStatus } from '../../domain/order-status';
import { Order } from '../../domain/order.entity';
import { CheckoutUnavailableError } from '../checkout-unavailable.error';
import { CheckoutEngineUnavailableError } from '../ports/checkout-saga-engine.port';
import type { OrderRefundEnginePort, RefundRunResult } from '../ports/order-refund-engine.port';
import type { OrderRepositoryPort } from '../ports/order-repository.port';
import { RefundOrderUseCase } from './refund-order.use-case';

const ORDER_ID = '137465797020397179';
const ADMIN_ID = '137465797020397182';
const OTHER_ADMIN_ID = '137465797020397190';

function order(status: OrderStatus): Order {
  return Order.rehydrate({
    id: ORDER_ID,
    userId: 'buyer-1',
    status,
    currency: 'VND',
    items: [],
    totalAmountMinor: 100_000,
    placedAt: new Date('2026-11-01T08:00:00Z'),
    finalizeReason: status === OrderStatus.REFUNDED ? 'admin:refund' : null,
  });
}

/** `found` is what the first read sees, `reread` what every read after the engine call sees. */
function build(found: Order | null, opts: { engine?: RefundRunResult | Error; reread?: Order } = {}) {
  const refund = vi.fn(() =>
    opts.engine instanceof Error
      ? Promise.reject(opts.engine)
      : Promise.resolve(opts.engine ?? { outcome: 'REFUNDED', requestedBy: ADMIN_ID }),
  );
  const findById = vi.fn(() =>
    Promise.resolve(refund.mock.calls.length > 0 ? (opts.reread ?? order(OrderStatus.REFUNDED)) : found),
  );
  const info = vi.fn();
  const useCase = new RefundOrderUseCase(
    { findById } as unknown as OrderRepositoryPort,
    { refund } as unknown as OrderRefundEnginePort,
    fakePinoLogger({ info }),
  );
  return { useCase, refund, findById, info };
}

const answerOf = (promise: Promise<{ settled: boolean }>) =>
  promise.then(
    ({ settled }) => (settled ? 200 : 202),
    (error: unknown) => {
      if (error instanceof HttpException) return error.getStatus();
      if (error instanceof CheckoutUnavailableError) return 503;
      throw error;
    },
  );

describe('RefundOrderUseCase', () => {
  it('refunds a paid order through the engine as the admin and answers the order as it now reads', async () => {
    const { useCase, refund, info } = build(order(OrderStatus.PAID));

    const answer = await useCase.refundAsAdmin(ORDER_ID, ADMIN_ID);

    expect(refund).toHaveBeenCalledExactlyOnceWith(ORDER_ID, ADMIN_ID);
    expect(answer).toMatchObject({
      settled: true,
      order: { id: ORDER_ID, status: OrderStatus.REFUNDED, finalizeReason: 'admin:refund' },
    });
    expect(info).toHaveBeenCalledWith({ orderId: ORDER_ID, adminId: ADMIN_ID }, 'refund requested');
  });

  it('answers 404 for an unknown order, before the engine hears of it', async () => {
    const { useCase, refund } = build(null);

    await expect(useCase.refundAsAdmin(ORDER_ID, ADMIN_ID)).rejects.toThrow(
      new NotFoundException(`Order not found: ${ORDER_ID}`),
    );
    expect(refund).not.toHaveBeenCalled();
  });

  it('answers a refunded order again without the engine, so a lost 200 can be retried', async () => {
    const { useCase, refund } = build(order(OrderStatus.REFUNDED));

    await expect(useCase.refundAsAdmin(ORDER_ID, ADMIN_ID)).resolves.toMatchObject({
      settled: true,
      order: { status: OrderStatus.REFUNDED },
    });
    expect(refund).not.toHaveBeenCalled();
  });

  const REFUNDABLE = new Set<OrderStatus>([OrderStatus.PAID, OrderStatus.REFUNDING, OrderStatus.REFUNDED]);
  const UNREFUNDABLE = ORDER_STATUSES.filter((status) => !REFUNDABLE.has(status));

  it.each(UNREFUNDABLE)('refuses a %s order with 409 and leaves the engine alone', async (status) => {
    const { useCase, refund } = build(order(status));

    await expect(useCase.refundAsAdmin(ORDER_ID, ADMIN_ID)).rejects.toThrow(
      new ConflictException(`Order cannot be refunded in status ${status}`),
    );
    expect(refund).not.toHaveBeenCalled();
  });

  it('joins a refund already running on a REFUNDING order', async () => {
    const { useCase, refund } = build(order(OrderStatus.REFUNDING));

    await expect(answerOf(useCase.refundAsAdmin(ORDER_ID, ADMIN_ID))).resolves.toBe(200);
    expect(refund).toHaveBeenCalledOnce();
  });

  it('answers 409 REFUND_FAILED with the provider reason, the order back at PAID', async () => {
    const { useCase } = build(order(OrderStatus.PAID), {
      engine: { outcome: 'REFUND_FAILED', reason: 'charge_disputed', requestedBy: ADMIN_ID },
      reread: order(OrderStatus.PAID),
    });

    const failure = await useCase.refundAsAdmin(ORDER_ID, ADMIN_ID).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConflictException);
    expect((failure as ConflictException).getResponse()).toEqual({ code: 'REFUND_FAILED', reason: 'charge_disputed' });
  });

  it('answers 409 naming the status the run found the order in', async () => {
    const { useCase } = build(order(OrderStatus.PAID), {
      engine: { outcome: 'NOT_REFUNDABLE', requestedBy: ADMIN_ID },
      reread: order(OrderStatus.CANCELLED),
    });

    await expect(useCase.refundAsAdmin(ORDER_ID, ADMIN_ID)).rejects.toThrow(
      new ConflictException(`Order cannot be refunded in status ${OrderStatus.CANCELLED}`),
    );
  });

  it.each([
    [OrderStatus.REFUNDING, 202],
    [OrderStatus.PAID, 202],
    [OrderStatus.REFUNDED, 200],
  ])('answers a run that outlived the wait by the order it left: %s → %i', async (status, http) => {
    const { useCase } = build(order(OrderStatus.PAID), { engine: { outcome: 'RUNNING' }, reread: order(status) });

    await expect(answerOf(useCase.refundAsAdmin(ORDER_ID, ADMIN_ID))).resolves.toBe(http);
  });

  it.each([
    [OrderStatus.REFUNDED, 200],
    [OrderStatus.REFUNDING, 202],
    [OrderStatus.PAID, 503],
  ])('reads an unconfirmed start by the order: %s → %i', async (status, http) => {
    const { useCase } = build(order(OrderStatus.PAID), {
      engine: new CheckoutEngineUnavailableError(),
      reread: order(status),
    });

    await expect(answerOf(useCase.refundAsAdmin(ORDER_ID, ADMIN_ID))).resolves.toBe(http);
  });

  it('keeps the engine fault as the cause of the 503', async () => {
    const fault = new CheckoutEngineUnavailableError();
    const { useCase } = build(order(OrderStatus.PAID), { engine: fault, reread: order(OrderStatus.PAID) });

    await expect(useCase.refundAsAdmin(ORDER_ID, ADMIN_ID)).rejects.toMatchObject({
      name: 'CheckoutUnavailableError',
      cause: fault,
    });
  });

  it('logs when the admin joined a run another admin started', async () => {
    const { useCase, info } = build(order(OrderStatus.REFUNDING), {
      engine: { outcome: 'REFUNDED', requestedBy: OTHER_ADMIN_ID },
    });

    await useCase.refundAsAdmin(ORDER_ID, ADMIN_ID);

    expect(info).toHaveBeenCalledWith(
      { orderId: ORDER_ID, adminId: ADMIN_ID, requestedBy: OTHER_ADMIN_ID },
      'refund joined a run another admin started',
    );
  });

  it('lets anything else the engine throws through', async () => {
    const bug = new TypeError('bug');
    const { useCase } = build(order(OrderStatus.PAID), { engine: bug });

    await expect(useCase.refundAsAdmin(ORDER_ID, ADMIN_ID)).rejects.toBe(bug);
  });
});
