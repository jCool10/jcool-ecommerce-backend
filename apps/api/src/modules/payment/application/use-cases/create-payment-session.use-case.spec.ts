import { BadGatewayException, ConflictException, HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Payment } from '../../domain/payment.entity';
import { PaymentStatus } from '../../domain/payment-status';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { OrderReadPort, OrderView } from '../ports/order-read.port';
import { DuplicateActivePaymentError } from '../ports/payment-repository.port';
import { PaymentGatewayError, type RetrievedSession } from '../ports/payment-gateway.port';
import { fakePaymentGateway, fakePaymentRepository } from '../../testing/payment-port.doubles';
import { CreatePaymentSessionUseCase } from './create-payment-session.use-case';

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NEW_PAYMENT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

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
    createError?: Error;
    sessionError?: Error;
    expireError?: Error;
    /** What `retrieveSession` answers for `existing`'s handle — only reachable when it is PENDING. */
    retrieveResult?: RetrievedSession;
    retrieveError?: Error;
    /** `null` simulates a webhook/sweep winning the compare-and-set race to retire a dead session. */
    retireWrite?: Payment | null;
  } = {},
) {
  const order = opts.order === undefined ? orderView() : opts.order;
  const findForPayment = vi.fn().mockResolvedValue(order);
  if (opts.orderAfter !== undefined) findForPayment.mockResolvedValueOnce(order).mockResolvedValue(opts.orderAfter);
  const create = opts.createError
    ? vi.fn().mockRejectedValue(opts.createError)
    : vi.fn().mockImplementation((payment: Payment) =>
        Promise.resolve(
          Payment.rehydrate({
            id: NEW_PAYMENT_ID,
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
    : vi.fn().mockResolvedValue({
        providerSessionId: 'cs_test_new',
        redirectUrl: 'https://checkout.stripe.test/pay/cs_test_new',
      });
  const updateStatus = vi
    .fn()
    .mockImplementation((_id: string, status: PaymentStatus) =>
      Promise.resolve(opts.retireWrite === undefined ? status : opts.retireWrite),
    );
  const expireSession = opts.expireError
    ? vi.fn().mockRejectedValue(opts.expireError)
    : vi.fn().mockResolvedValue('expired');
  const retrieveSession = opts.retrieveError
    ? vi.fn().mockRejectedValue(opts.retrieveError)
    : vi.fn().mockResolvedValue(opts.retrieveResult ?? { status: 'UNKNOWN' });
  const metrics = fakeMetricsPort();

  const useCase = new CreatePaymentSessionUseCase(
    { findForPayment } as unknown as OrderReadPort,
    fakePaymentRepository({ findByOrderId: vi.fn().mockResolvedValue(opts.existing ?? null), create, updateStatus }),
    fakePaymentGateway({ createSession, expireSession, retrieveSession }),
    metrics,
    fakePinoLogger(),
  );
  return { useCase, create, createSession, expireSession, retrieveSession, updateStatus, metrics };
}

describe('CreatePaymentSessionUseCase', () => {
  it('refuses before reaching the gateway, counting no saga step', async () => {
    const cases: Record<string, Parameters<typeof build>[0]> = {
      'unknown order': { order: null },
      "someone else's order": { order: orderView({ userId: OTHER }) },
      'order not pending': { order: orderView({ status: 'DRAFT' }) },
      // Already owns the order's charge; unlike a PENDING payment, there is nothing to ask the
      // gateway to reuse.
      'payment already succeeded': { existing: persistedPayment(PaymentStatus.SUCCEEDED) },
    };

    const outcomes = await Promise.all(
      Object.entries(cases).map(async ([label, opts]) => {
        const { useCase, createSession, metrics } = build(opts);
        const status = await useCase.execute(ORDER_ID, OWNER).then(
          () => 'resolved',
          (error: unknown) => (error instanceof HttpException ? error.getStatus() : error),
        );
        return [label, status, createSession.mock.calls.length, metrics.recordSagaStep.mock.calls.length];
      }),
    );

    expect(outcomes).toEqual([
      ['unknown order', 404, 0, 0],
      ["someone else's order", 404, 0, 0],
      ['order not pending', 409, 0, 0],
      ['payment already succeeded', 409, 0, 0],
    ]);
  });

  describe('an existing PENDING payment', () => {
    it('reuses the still-open session, counting a successful saga step', async () => {
      const { useCase, createSession, updateStatus, metrics } = build({
        existing: persistedPayment(PaymentStatus.PENDING),
        retrieveResult: { status: 'PENDING', redirectUrl: 'https://checkout.stripe.test/pay/cs_test_prior' },
      });

      const result = await useCase.execute(ORDER_ID, OWNER);

      expect(result).toEqual({
        paymentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        providerSessionId: 'cs_test_prior',
        redirectUrl: 'https://checkout.stripe.test/pay/cs_test_prior',
        clientSecret: undefined,
      });
      expect(createSession).not.toHaveBeenCalled();
      expect(updateStatus).not.toHaveBeenCalled();
      expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('payment_session', 'success');
    });

    it('retires a session the gateway confirms has failed, then opens a fresh one', async () => {
      const { useCase, create, createSession, updateStatus, retrieveSession } = build({
        existing: persistedPayment(PaymentStatus.PENDING),
        retrieveResult: { status: 'FAILED' },
      });

      const result = await useCase.execute(ORDER_ID, OWNER);

      expect(retrieveSession).toHaveBeenCalledExactlyOnceWith('cs_test_prior');
      expect(updateStatus).toHaveBeenCalledExactlyOnceWith(
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        PaymentStatus.FAILED,
        {
          expectedStatus: PaymentStatus.PENDING,
        },
      );
      expect(createSession).toHaveBeenCalledOnce();
      expect(create.mock.calls[0][0]).toMatchObject({ providerSessionId: 'cs_test_new' });
      expect(result.providerSessionId).toBe('cs_test_new');
    });

    // PAID: money may already be moving on the row we still call PENDING. UNKNOWN: no proof the old
    // session is dead. Neither is safe to replace.
    it.each([['PAID'], ['UNKNOWN']] as const)(
      'refuses rather than replace a session the gateway reports as %s',
      async (status) => {
        const { useCase, createSession, updateStatus } = build({
          existing: persistedPayment(PaymentStatus.PENDING),
          retrieveResult: { status },
        });

        await expect(useCase.execute(ORDER_ID, OWNER)).rejects.toThrow('already has an active payment (PENDING)');
        expect(createSession).not.toHaveBeenCalled();
        expect(updateStatus).not.toHaveBeenCalled();
      },
    );

    it('answers a gateway failure retrieving the session with 502, counting a failed step', async () => {
      const { useCase, createSession, metrics } = build({
        existing: persistedPayment(PaymentStatus.PENDING),
        retrieveError: new PaymentGatewayError('stripe down'),
      });

      await expect(useCase.execute(ORDER_ID, OWNER)).rejects.toBeInstanceOf(BadGatewayException);
      expect(createSession).not.toHaveBeenCalled();
      expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('payment_session', 'failed');
    });

    // A webhook or the sweep settled the row in the gap between the probe and the retiring write.
    it('refuses rather than race a settlement that lands while retiring a dead session', async () => {
      const { useCase, createSession } = build({
        existing: persistedPayment(PaymentStatus.PENDING),
        retrieveResult: { status: 'FAILED' },
        retireWrite: null,
      });

      await expect(useCase.execute(ORDER_ID, OWNER)).rejects.toThrow('already has an active payment (PENDING)');
      expect(createSession).not.toHaveBeenCalled();
    });
  });

  it('opens a fresh session after a failed payment, snapshotting the order amount', async () => {
    const { useCase, create, createSession, expireSession, metrics } = build({
      existing: persistedPayment(PaymentStatus.FAILED),
    });

    const result = await useCase.execute(ORDER_ID, OWNER);

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, amountMinor: 150_000, currency: 'VND' }),
    );
    expect(create.mock.calls[0][0]).toMatchObject({
      status: PaymentStatus.PENDING,
      amountMinor: 150_000,
      provider: 'stripe',
      providerSessionId: 'cs_test_new',
    });
    expect(result).toEqual({
      paymentId: NEW_PAYMENT_ID,
      providerSessionId: 'cs_test_new',
      redirectUrl: 'https://checkout.stripe.test/pay/cs_test_new',
      clientSecret: undefined,
    });
    expect(expireSession).not.toHaveBeenCalled();
    expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('payment_session', 'success');
  });

  // The order is left holding stock it cannot pay for, so this one is a failed step.
  it('answers a gateway failure with 502, persisting nothing and counting a failed step', async () => {
    const { useCase, create, metrics } = build({ sessionError: new PaymentGatewayError('stripe down') });

    await expect(useCase.execute(ORDER_ID, OWNER)).rejects.toBeInstanceOf(BadGatewayException);
    expect(create).not.toHaveBeenCalled();
    expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('payment_session', 'failed');
  });

  it('answers a lost unique-index race with 409 and counts no step', async () => {
    const { useCase, metrics } = build({ createError: new DuplicateActivePaymentError(ORDER_ID) });

    await expect(useCase.execute(ORDER_ID, OWNER)).rejects.toBeInstanceOf(ConflictException);
    expect(metrics.recordSagaStep).not.toHaveBeenCalled();
  });

  // The cancel consumer has already looked for a payment row and found none, so if this request
  // does not close the session it opened, nothing will.
  it('closes the session, expires the payment, and 409s when the order settled meanwhile', async () => {
    for (const [orderAfter, status] of [
      [orderView({ status: 'CANCELLED' }), 'CANCELLED'],
      [null, 'DELETED'],
    ] as const) {
      const { useCase, expireSession, updateStatus, metrics } = build({ orderAfter });

      await expect(useCase.execute(ORDER_ID, OWNER)).rejects.toThrow(`not payable in status ${status}`);

      expect(expireSession).toHaveBeenCalledExactlyOnceWith('cs_test_new');
      // CAS on PENDING: a webhook that settled this payment in the same window keeps its outcome.
      expect(updateStatus).toHaveBeenCalledExactlyOnceWith(NEW_PAYMENT_ID, PaymentStatus.EXPIRED, {
        expectedStatus: PaymentStatus.PENDING,
      });
      expect(metrics.recordSagaStep).not.toHaveBeenCalled();
    }
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
});
