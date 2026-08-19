import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Payment } from '../domain/payment.entity';
import { PaymentStatus } from '../domain/payment-status';
import type { OrderReadPort, OrderView } from './ports/order-read.port';
import { DuplicateActivePaymentError, type PaymentRepositoryPort } from './ports/payment-repository.port';
import type { GatewaySession, PaymentGatewayPort } from './ports/payment-gateway.port';
import { CreatePaymentSessionUseCase } from './create-payment-session.use-case';

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function orderView(overrides: Partial<OrderView> = {}): OrderView {
  return { id: ORDER_ID, userId: OWNER, status: 'PENDING', amountMinor: 150_000, currency: 'VND', ...overrides };
}

function persistedPayment(status: PaymentStatus): Payment {
  return Payment.rehydrate({
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    orderId: ORDER_ID,
    provider: 'stripe',
    providerSessionId: 'cs_test_prior',
    providerIntentId: null,
    amountMinor: 150_000,
    currency: 'VND',
    status,
  });
}

function build(
  opts: { order?: OrderView | null; existing?: Payment | null; session?: GatewaySession; createError?: Error } = {},
) {
  const findForPayment = vi.fn().mockResolvedValue(opts.order === undefined ? orderView() : opts.order);
  const findByOrderId = vi.fn().mockResolvedValue(opts.existing ?? null);
  const create = opts.createError
    ? vi.fn().mockRejectedValue(opts.createError)
    : vi.fn().mockImplementation((payment: Payment) =>
        Promise.resolve(
          Payment.rehydrate({
            id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            orderId: payment.orderId,
            provider: payment.provider,
            providerSessionId: payment.providerSessionId,
            providerIntentId: null,
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            status: payment.status,
          }),
        ),
      );
  const createSession = vi
    .fn()
    .mockResolvedValue(
      opts.session ?? { providerSessionId: 'cs_test_new', redirectUrl: 'https://checkout.stripe.test/pay/cs_test_new' },
    );

  const orders = { findForPayment } as OrderReadPort;
  const payments = { findByOrderId, create, updateStatus: vi.fn() } as unknown as PaymentRepositoryPort;
  const gateway = { provider: 'stripe', createSession, verifyAndParseEvent: vi.fn() } as unknown as PaymentGatewayPort;

  const useCase = new CreatePaymentSessionUseCase(orders, payments, gateway);
  return { useCase, findForPayment, findByOrderId, create, createSession };
}

describe('CreatePaymentSessionUseCase', () => {
  it('opens a session and persists a PENDING payment with the order amount snapshot', async () => {
    const { useCase, create, createSession } = build();

    const result = await useCase.execute(ORDER_ID, OWNER);

    // Amount + currency come from the order, never the caller.
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, amountMinor: 150_000, currency: 'VND' }),
    );
    const persisted = create.mock.calls[0][0] as Payment;
    expect(persisted.status).toBe(PaymentStatus.PENDING);
    expect(persisted.amountMinor).toBe(150_000);
    expect(persisted.provider).toBe('stripe'); // authoritative from the gateway, not config
    expect(persisted.providerSessionId).toBe('cs_test_new');
    expect(result).toEqual({
      paymentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      providerSessionId: 'cs_test_new',
      redirectUrl: 'https://checkout.stripe.test/pay/cs_test_new',
      clientSecret: undefined,
    });
  });

  it('404s when the order does not exist (no gateway call, no persist)', async () => {
    const { useCase, createSession, create } = build({ order: null });
    await expect(useCase.execute(ORDER_ID, OWNER)).rejects.toBeInstanceOf(NotFoundException);
    expect(createSession).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('404s (not 403) when the order belongs to another user — never leaks its existence', async () => {
    const { useCase, createSession } = build({ order: orderView({ userId: OTHER }) });
    await expect(useCase.execute(ORDER_ID, OWNER)).rejects.toBeInstanceOf(NotFoundException);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('409s when the order is not PENDING', async () => {
    const { useCase, createSession } = build({ order: orderView({ status: 'DRAFT' }) });
    await expect(useCase.execute(ORDER_ID, OWNER)).rejects.toBeInstanceOf(ConflictException);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('409s when an active PENDING payment already exists (never double-charge)', async () => {
    const { useCase, createSession } = build({ existing: persistedPayment(PaymentStatus.PENDING) });
    await expect(useCase.execute(ORDER_ID, OWNER)).rejects.toBeInstanceOf(ConflictException);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('409s when a SUCCEEDED payment exists even though the order is still PENDING', async () => {
    const { useCase, createSession } = build({ existing: persistedPayment(PaymentStatus.SUCCEEDED) });
    await expect(useCase.execute(ORDER_ID, OWNER)).rejects.toBeInstanceOf(ConflictException);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('allows a fresh session when the prior payment FAILED', async () => {
    const { useCase, create } = build({ existing: persistedPayment(PaymentStatus.FAILED) });
    const result = await useCase.execute(ORDER_ID, OWNER);
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.providerSessionId).toBe('cs_test_new');
  });

  it('maps the DB active-payment race (concurrent insert lost the unique index) to 409, not 500', async () => {
    const { useCase, createSession } = build({ createError: new DuplicateActivePaymentError(ORDER_ID) });
    await expect(useCase.execute(ORDER_ID, OWNER)).rejects.toBeInstanceOf(ConflictException);
    expect(createSession).toHaveBeenCalledTimes(1); // pre-check passed; the DB backstop caught the race
  });
});
