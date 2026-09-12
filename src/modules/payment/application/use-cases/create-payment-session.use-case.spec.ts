import { BadGatewayException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Payment } from '../../domain/payment.entity';
import { PaymentStatus } from '../../domain/payment-status';
import { fakeMetricsPort } from '@shared/testing/fake-metrics-port';
import { fakePinoLogger } from '@shared/testing/fake-pino-logger';
import type { OrderReadPort, OrderView } from '../ports/order-read.port';
import { DuplicateActivePaymentError } from '../ports/payment-repository.port';
import { PaymentGatewayError, type GatewaySession } from '../ports/payment-gateway.port';
import { fakePaymentGateway, fakePaymentRepository } from '../../testing/payment-port.doubles';
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
  opts: {
    order?: OrderView | null;
    /** What the post-write re-read sees, when it differs from the order the request started on. */
    orderAfter?: OrderView | null;
    existing?: Payment | null;
    session?: GatewaySession;
    createError?: Error;
    sessionError?: Error;
    expireError?: Error;
  } = {},
) {
  const order = opts.order === undefined ? orderView() : opts.order;
  const findForPayment = vi.fn().mockResolvedValue(order);
  if (opts.orderAfter !== undefined) findForPayment.mockResolvedValueOnce(order).mockResolvedValue(opts.orderAfter);
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
  const createSession = opts.sessionError
    ? vi.fn().mockRejectedValue(opts.sessionError)
    : vi.fn().mockResolvedValue(
        opts.session ?? {
          providerSessionId: 'cs_test_new',
          redirectUrl: 'https://checkout.stripe.test/pay/cs_test_new',
        },
      );

  const updateStatus = vi.fn().mockImplementation((_id: string, status: PaymentStatus) => Promise.resolve(status));
  const expireSession = opts.expireError
    ? vi.fn().mockRejectedValue(opts.expireError)
    : vi.fn().mockResolvedValue('expired');

  const orders = { findForPayment } as unknown as OrderReadPort;
  const payments = fakePaymentRepository({ findByOrderId, create, updateStatus });
  const gateway = fakePaymentGateway({ createSession, expireSession });

  const recordSagaStep = vi.fn();

  const useCase = new CreatePaymentSessionUseCase(
    orders,
    payments,
    gateway,
    fakeMetricsPort({ recordSagaStep }),
    fakePinoLogger(),
  );
  return { useCase, findForPayment, findByOrderId, create, createSession, expireSession, updateStatus, recordSagaStep };
}

describe('CreatePaymentSessionUseCase', () => {
  it('opens a session and persists a PENDING payment with the order amount snapshot', async () => {
    const { useCase, create, createSession } = build();

    const result = await useCase.execute(ORDER_ID, OWNER);

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

  it('maps a gateway/provider failure to 502 (BadGateway) and persists nothing', async () => {
    const { useCase, create } = build({ sessionError: new PaymentGatewayError('stripe down') });
    await expect(useCase.execute(ORDER_ID, OWNER)).rejects.toBeInstanceOf(BadGatewayException);
    expect(create).not.toHaveBeenCalled();
  });

  it('counts the saga step once the payment is persisted', async () => {
    const { useCase, recordSagaStep } = build();
    await useCase.execute(ORDER_ID, OWNER);
    expect(recordSagaStep).toHaveBeenCalledExactlyOnceWith('payment_session', 'success');
  });

  it('counts a gateway failure as a failed step — the order is stuck holding stock it cannot pay for', async () => {
    const { useCase, recordSagaStep } = build({ sessionError: new PaymentGatewayError('stripe down') });
    await expect(useCase.execute(ORDER_ID, OWNER)).rejects.toBeInstanceOf(BadGatewayException);
    expect(recordSagaStep).toHaveBeenCalledExactlyOnceWith('payment_session', 'failed');
  });

  // A refused request is not a broken saga: the order is exactly where it was, and counting these
  // would turn every duplicate tab into a failure rate nobody can act on.
  it.each([
    ['unknown order', { order: null }],
    ['order not payable', { order: orderView({ status: 'DRAFT' }) }],
    ['active payment already open', { existing: persistedPayment(PaymentStatus.PENDING) }],
    ['lost the unique-index race', { createError: new DuplicateActivePaymentError(ORDER_ID) }],
  ])('does not count a step when the request is refused (%s)', async (_case, opts) => {
    const { useCase, recordSagaStep } = build(opts);
    await expect(useCase.execute(ORDER_ID, OWNER)).rejects.toBeInstanceOf(Error);
    expect(recordSagaStep).not.toHaveBeenCalled();
  });

  // The cancel consumer has already looked for a payment row and found none, so if this request
  // does not close the session it opened, nothing will.
  describe('when the order settles while the session is being opened', () => {
    it('closes the session, expires the payment, and 409s', async () => {
      const { useCase, expireSession, updateStatus, recordSagaStep } = build({
        orderAfter: orderView({ status: 'CANCELLED' }),
      });

      await expect(useCase.execute(ORDER_ID, OWNER)).rejects.toThrow(/not payable in status CANCELLED/);

      expect(expireSession).toHaveBeenCalledExactlyOnceWith('cs_test_new');
      // CAS on PENDING: a webhook that settled this payment inside the same window keeps its outcome.
      expect(updateStatus).toHaveBeenCalledExactlyOnceWith(
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        PaymentStatus.EXPIRED,
        {
          expectedStatus: PaymentStatus.PENDING,
        },
      );
      expect(recordSagaStep).not.toHaveBeenCalled();
    });

    it('409s on a deleted order too — an id that no longer reads back is not payable', async () => {
      const { useCase, expireSession } = build({ orderAfter: null });
      await expect(useCase.execute(ORDER_ID, OWNER)).rejects.toThrow(/not payable in status DELETED/);
      expect(expireSession).toHaveBeenCalledTimes(1);
    });

    it('leaves the payment PENDING when the session cannot be closed, and still 409s', async () => {
      const { useCase, updateStatus } = build({
        orderAfter: orderView({ status: 'EXPIRED' }),
        expireError: new PaymentGatewayError('stripe unreachable'),
      });

      await expect(useCase.execute(ORDER_ID, OWNER)).rejects.toBeInstanceOf(ConflictException);

      // Marking it EXPIRED here would claim a session was closed that is still live at the gateway.
      expect(updateStatus).not.toHaveBeenCalled();
    });

    it('does not touch the gateway when the order is still PENDING on the re-read', async () => {
      const { useCase, expireSession, findForPayment, recordSagaStep } = build();
      await useCase.execute(ORDER_ID, OWNER);
      expect(findForPayment).toHaveBeenCalledTimes(2);
      expect(expireSession).not.toHaveBeenCalled();
      expect(recordSagaStep).toHaveBeenCalledExactlyOnceWith('payment_session', 'success');
    });
  });
});
