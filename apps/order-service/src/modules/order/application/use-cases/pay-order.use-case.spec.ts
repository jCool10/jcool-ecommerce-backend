import { BadGatewayException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { Order } from '../../domain/order.entity';
import { OrderItem } from '../../domain/order-item.entity';
import { OrderStatus } from '../../domain/order-status';
import {
  PaymentProviderUnavailableError,
  type OrderPaymentParticipantPort,
  type PaymentSessionResult,
} from '../ports/order-payment-participant.port';
import type { OrderRepositoryPort } from '../ports/order-repository.port';
import { PayOrderUseCase } from './pay-order.use-case';

const CUTOFF_SEC = 1980;
const TOTAL = 3_000_000_000;

function order(overrides: { status?: OrderStatus; deadlineInSec?: number | null } = {}): Order {
  const deadlineInSec = overrides.deadlineInSec === undefined ? 3600 : overrides.deadlineInSec;
  return Order.rehydrate({
    id: 'order-1',
    userId: 'u1',
    status: overrides.status ?? OrderStatus.PENDING,
    currency: 'VND',
    items: [OrderItem.of('sku-1', 'Widget', TOTAL / 2, 2)],
    totalAmountMinor: TOTAL,
    placedAt: new Date(),
    paymentDeadlineAt: deadlineInSec === null ? null : new Date(Date.now() + deadlineInSec * 1000),
  });
}

const OPENED: PaymentSessionResult = {
  outcome: 'OPENED',
  paymentId: 'pay-1',
  providerSessionId: 'cs_1',
  redirectUrl: 'https://checkout.stripe.test/pay/cs_1',
};

function build(opts: { found?: Order | null; session?: PaymentSessionResult | Error } = {}) {
  const findForUser = vi.fn().mockResolvedValue(opts.found === undefined ? order() : opts.found);
  const session = opts.session ?? OPENED;
  const openSession = vi.fn(() => (session instanceof Error ? Promise.reject(session) : Promise.resolve(session)));
  const useCase = new PayOrderUseCase(
    { findForUser } as unknown as OrderRepositoryPort,
    { openSession } as unknown as OrderPaymentParticipantPort,
    fakeConfigService({ checkoutSaga: { payCutoffSec: CUTOFF_SEC } }),
    fakePinoLogger(),
  );
  return { useCase, findForUser, openSession };
}

describe('PayOrderUseCase', () => {
  it('opens a session for the order total that dies at the payment deadline', async () => {
    const placed = order();
    const { useCase, findForUser, openSession } = build({ found: placed });

    const session = await useCase.execute('order-1', 'u1');

    expect(session).toEqual({
      paymentId: 'pay-1',
      providerSessionId: 'cs_1',
      redirectUrl: 'https://checkout.stripe.test/pay/cs_1',
      clientSecret: undefined,
    });
    expect(findForUser).toHaveBeenCalledWith('order-1', 'u1');
    expect(openSession).toHaveBeenCalledExactlyOnceWith({
      orderId: 'order-1',
      amountMinor: TOTAL,
      currency: 'VND',
      expiresAt: placed.paymentDeadlineAt,
    });
  });

  it('answers 404 for an order the buyer cannot see', async () => {
    const { useCase, openSession } = build({ found: null });

    await expect(useCase.execute('order-1', 'u1')).rejects.toThrow(new NotFoundException('Order not found: order-1'));
    expect(openSession).not.toHaveBeenCalled();
  });

  it('answers 409 for an order past PENDING', async () => {
    for (const status of [OrderStatus.CONFIRMING, OrderStatus.PAID, OrderStatus.CANCELLED, OrderStatus.EXPIRED]) {
      const { useCase, openSession } = build({ found: order({ status }) });

      await expect(useCase.execute('order-1', 'u1')).rejects.toThrow(
        new ConflictException(`Order is not payable in status ${status}`),
      );
      expect(openSession).not.toHaveBeenCalled();
    }
  });

  it('answers 409 once less than the cutoff is left, or with no deadline at all', async () => {
    for (const deadlineInSec of [CUTOFF_SEC - 1, -10, null]) {
      const { useCase, openSession } = build({ found: order({ deadlineInSec }) });

      await expect(useCase.execute('order-1', 'u1'), String(deadlineInSec)).rejects.toThrow(
        new ConflictException('Payment window for this order has closed'),
      );
      expect(openSession).not.toHaveBeenCalled();
    }
  });

  it('still opens with the cutoff not yet reached', async () => {
    const { useCase, openSession } = build({ found: order({ deadlineInSec: CUTOFF_SEC + 5 }) });

    await useCase.execute('order-1', 'u1');

    expect(openSession).toHaveBeenCalledOnce();
  });

  it('answers 409 when payment has closed the order', async () => {
    const { useCase } = build({ session: { outcome: 'CLOSED' } });

    await expect(useCase.execute('order-1', 'u1')).rejects.toThrow(new ConflictException('Order is no longer payable'));
  });

  it('answers 502 when the provider cannot open a session', async () => {
    const { useCase } = build({ session: new PaymentProviderUnavailableError({ cause: new Error('circuit open') }) });

    const error: unknown = await useCase.execute('order-1', 'u1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadGatewayException);
    expect((error as BadGatewayException).message).toBe('Payment provider is temporarily unavailable');
  });

  it('lets any other fault through', async () => {
    const boom = new Error('db down');
    const { useCase } = build({ session: boom });

    await expect(useCase.execute('order-1', 'u1')).rejects.toBe(boom);
  });
});
