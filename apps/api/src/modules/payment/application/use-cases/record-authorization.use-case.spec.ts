import { describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { DrizzleTx } from '@shared/infrastructure/database';
import type { OutboxWriterPort } from '@shared/messaging/outbox/outbox-writer.port';
import { Payment } from '../../domain/payment.entity';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentStatus } from '../../domain/payment-status';
import type { SessionAuthorization } from '../ports/payment-gateway.port';
import type { PaymentOrderHeader } from '../ports/payment-order-repository.port';
import { fakePaymentOrderRepository, fakePaymentRepository } from '../../testing/payment-port.doubles';
import { RecordAuthorizationUseCase, type AuthorizationToRecord } from './record-authorization.use-case';

const ORDER_ID = '7400000000000000002';
const PAYMENT_ID = '7400000000000000001';
const OUTBOX_ID = '7400000000000000009';
const SESSION_ID = 'cs_fake_1';
const AUTHORIZED_AT = new Date('2026-10-06T10:00:00.000Z');
const tx = { __tx: true } as unknown as DrizzleTx;

const header = (status: PaymentOrderStatus, money: Partial<PaymentOrderHeader> = {}): PaymentOrderHeader => ({
  orderId: ORDER_ID,
  status,
  amountMinor: 150_000,
  currency: 'VND',
  ...money,
});

const payment = (status: PaymentStatus = PaymentStatus.PENDING, amountMinor = 150_000) =>
  Payment.rehydrate({
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    provider: 'stripe',
    providerSessionId: SESSION_ID,
    providerIntentId: null,
    amountMinor,
    currency: 'VND',
    status,
  });

const hold = (overrides: Partial<SessionAuthorization> = {}): SessionAuthorization => ({
  sessionStatus: 'complete',
  intentId: 'pi_1',
  intentStatus: 'requires_capture',
  amountCapturableMinor: 150_000,
  currency: 'vnd',
  ...overrides,
});

function build(opts: { header?: PaymentOrderHeader | null; payment?: Payment | null } = {}) {
  const calls: string[] = [];
  const findHeader = vi.fn().mockImplementation(() => {
    calls.push('lock header');
    return Promise.resolve(opts.header === undefined ? header(PaymentOrderStatus.OPEN) : opts.header);
  });
  const updateHeader = vi.fn().mockResolvedValue(true);
  const current = opts.payment === undefined ? payment() : opts.payment;
  const findPayment = vi.fn().mockImplementation(() => {
    calls.push('lock payment');
    return Promise.resolve(current);
  });
  const updatePayment = vi.fn().mockResolvedValue(current);
  const append = vi.fn<OutboxWriterPort['append']>().mockResolvedValue(undefined);
  const error = vi.fn();
  const useCase = new RecordAuthorizationUseCase(
    fakePaymentOrderRepository({ findForUpdate: findHeader, updateStatus: updateHeader }),
    fakePaymentRepository({ findByProviderSessionId: findPayment, updateStatus: updatePayment }),
    { append },
    fakePinoLogger({ error }),
  );
  return { useCase, findHeader, updateHeader, findPayment, updatePayment, append, error, calls };
}

const input = (authorization: SessionAuthorization = hold()): AuthorizationToRecord => ({
  orderId: ORDER_ID,
  providerSessionId: SESSION_ID,
  authorization,
  authorizedAt: AUTHORIZED_AT,
  outboxId: OUTBOX_ID,
});

describe('RecordAuthorizationUseCase', () => {
  it('records the hold, moves an open header to AUTHORIZED and emits payment.authorized', async () => {
    const { useCase, findHeader, updateHeader, findPayment, updatePayment, append, calls } = build();

    await expect(useCase.execute(tx, input())).resolves.toEqual({
      outcome: 'authorized',
      paymentId: PAYMENT_ID,
      headerStatus: PaymentOrderStatus.AUTHORIZED,
    });

    // Header before payment: the one lock order every fenced transaction shares.
    expect(calls).toEqual(['lock header', 'lock payment']);
    expect(findHeader).toHaveBeenCalledWith(tx, ORDER_ID);
    expect(findPayment).toHaveBeenCalledWith(SESSION_ID, tx);
    expect(updatePayment).toHaveBeenCalledWith(PAYMENT_ID, PaymentStatus.AUTHORIZED, {
      tx,
      providerIntentId: 'pi_1',
      authorizedAt: AUTHORIZED_AT,
      expectedStatus: PaymentStatus.PENDING,
    });
    expect(updateHeader).toHaveBeenCalledWith(tx, ORDER_ID, PaymentOrderStatus.AUTHORIZED, PaymentOrderStatus.OPEN);
    // The id was minted by the caller before its transaction opened.
    expect(append).toHaveBeenCalledWith(
      tx,
      {
        aggregateType: 'Payment',
        aggregateId: PAYMENT_ID,
        eventType: 'payment.authorized',
        payload: {
          paymentId: PAYMENT_ID,
          orderId: ORDER_ID,
          amountMinor: 150_000,
          currency: 'VND',
          authorizedAt: AUTHORIZED_AT.toISOString(),
        },
      },
      OUTBOX_ID,
    );
  });

  // A late hold under a cancel still has to be voided, and only the event tells the saga it exists.
  it('records a late hold under a cancelled header without reopening it', async () => {
    const { useCase, updateHeader, append } = build({ header: header(PaymentOrderStatus.CANCELLED) });

    await expect(useCase.execute(tx, input())).resolves.toMatchObject({
      outcome: 'authorized',
      headerStatus: PaymentOrderStatus.CANCELLED,
    });
    expect(updateHeader).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledOnce();
  });

  it('records nothing for a hold that does not match the header or the payment', async () => {
    const mismatches: Record<string, Parameters<typeof build>[0] & { hold?: SessionAuthorization }> = {
      'held amount differs from the header': { hold: hold({ amountCapturableMinor: 149_999 }) },
      'held currency differs from the header': { hold: hold({ currency: 'usd' }) },
      'header amount differs from the payment': { payment: payment(PaymentStatus.PENDING, 99_000) },
      'fenced header carries no amount': {
        header: header(PaymentOrderStatus.FENCED, { amountMinor: null, currency: null }),
      },
    };

    for (const [name, { hold: held, ...opts }] of Object.entries(mismatches)) {
      const { useCase, updatePayment, append, error } = build(opts);

      await expect(useCase.execute(tx, input(held)), name).resolves.toEqual({
        outcome: 'skipped',
        reason: 'amount_mismatch',
      });
      expect(updatePayment, name).not.toHaveBeenCalled();
      expect(append, name).not.toHaveBeenCalled();
      expect(error, name).toHaveBeenCalledOnce();
    }
  });

  it('leaves anything but a capturable hold on a pending payment alone', async () => {
    const cases: Record<string, [Parameters<typeof build>[0], SessionAuthorization, string]> = {
      'intent still processing': [{}, hold({ intentStatus: 'processing' }), 'not_authorized'],
      'no intent yet': [{}, { sessionStatus: 'open' }, 'not_authorized'],
      'already recorded': [{ payment: payment(PaymentStatus.AUTHORIZED) }, hold(), 'already_recorded'],
      'already voided': [{ payment: payment(PaymentStatus.VOIDED) }, hold(), 'conflict'],
      'no payment': [{ payment: null }, hold(), 'payment_not_found'],
      'no header': [{ header: null }, hold(), 'payment_not_found'],
    };

    for (const [name, [opts, held, reason]] of Object.entries(cases)) {
      const { useCase, updatePayment, append } = build(opts);

      await expect(useCase.execute(tx, input(held)), name).resolves.toEqual({ outcome: 'skipped', reason });
      expect(updatePayment, name).not.toHaveBeenCalled();
      expect(append, name).not.toHaveBeenCalled();
    }
  });
});
