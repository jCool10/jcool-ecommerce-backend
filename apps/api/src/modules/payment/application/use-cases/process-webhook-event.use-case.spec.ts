import { describe, expect, it, vi } from 'vitest';
import type { OutboxWriterPort } from '@shared/messaging/outbox/outbox-writer.port';
import { Payment } from '../../domain/payment.entity';
import { PaymentStatus } from '../../domain/payment-status';
import { WebhookEvent } from '../../domain/webhook-event.entity';
import type { VerifiedEvent } from '../ports/payment-gateway.port';
import { fakePaymentGateway, fakePaymentRepository } from '../../testing/payment-port.doubles';
import type { WebhookEventRepositoryPort } from '../ports/webhook-event-repository.port';
import type { TransactionRunnerPort } from '../ports/transaction-runner.port';
import { ProcessWebhookEventUseCase } from './process-webhook-event.use-case';

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAYMENT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const EVENT_ROW_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SESSION_ID = 'cs_fake_session';
const AMOUNT_MINOR = 150_000;
const CURRENCY = 'VND';

/**
 * Defaults describe a cleared charge that matches the payment, so each test overrides only the one
 * field it is about. `null` means the gateway omitted the field entirely, which is distinct from
 * sending a wrong value.
 */
function stripeEvent(
  type: string,
  opts: {
    id?: string;
    sessionId?: string;
    intentId?: string;
    paymentStatus?: string | null;
    amountMinor?: number | null;
    currency?: string | null;
  } = {},
): Record<string, unknown> {
  const object: Record<string, unknown> = { id: opts.sessionId ?? SESSION_ID, payment_intent: opts.intentId };
  if (opts.paymentStatus !== null) object.payment_status = opts.paymentStatus ?? 'paid';
  if (opts.amountMinor !== null) object.amount_total = opts.amountMinor ?? AMOUNT_MINOR;
  if (opts.currency !== null) object.currency = opts.currency ?? CURRENCY.toLowerCase();
  return { id: opts.id ?? 'evt_1', type, data: { object } };
}

function verified(payload: Record<string, unknown>): VerifiedEvent {
  return { kind: 'valid', providerEventId: payload.id as string, type: payload.type as string, payload };
}

function payment(status: PaymentStatus): Payment {
  return Payment.rehydrate({
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    provider: 'stripe',
    providerSessionId: SESSION_ID,
    providerIntentId: null,
    amountMinor: AMOUNT_MINOR,
    currency: CURRENCY,
    status,
  });
}

function eventRow(): WebhookEvent {
  return WebhookEvent.rehydrate({
    id: EVENT_ROW_ID,
    provider: 'stripe',
    providerEventId: 'evt_1',
    type: 'checkout.session.completed',
    payload: {},
    status: 'RECEIVED',
    receivedAt: new Date(),
    processedAt: null,
  });
}

function build(opts: { verify: VerifiedEvent; inserted?: boolean; existing?: Payment | null }) {
  const insertIfNew = vi.fn().mockResolvedValue({ inserted: opts.inserted ?? true, event: eventRow() });
  const markProcessed = vi.fn().mockResolvedValue(undefined);
  const markSkipped = vi.fn().mockResolvedValue(undefined);
  const findByProviderSessionId = vi.fn().mockResolvedValue(opts.existing ?? null);
  const updateStatus = vi.fn().mockResolvedValue(opts.existing ?? null);
  const verifyAndParseEvent = vi.fn().mockReturnValue(opts.verify);

  const webhookEvents = { insertIfNew, markProcessed, markSkipped } as unknown as WebhookEventRepositoryPort;
  const payments = fakePaymentRepository({ findByProviderSessionId, updateStatus });
  const gateway = fakePaymentGateway({ verifyAndParseEvent });
  // A sentinel tx handle the runner threads into `work`; tests assert every DB call received THIS
  // exact object, proving the insert + apply + mark all run inside the one transaction.
  const tx = { __tx: true };
  const txRunner = {
    run: vi.fn().mockImplementation((work: (t: unknown) => unknown) => work(tx)),
  } as unknown as TransactionRunnerPort;

  const append = vi.fn<OutboxWriterPort['append']>().mockResolvedValue(undefined);
  const outbox: OutboxWriterPort = { append };

  const useCase = new ProcessWebhookEventUseCase(txRunner, gateway, webhookEvents, payments, outbox);
  return {
    useCase,
    tx,
    insertIfNew,
    markProcessed,
    markSkipped,
    findByProviderSessionId,
    updateStatus,
    verifyAndParseEvent,
    append,
  };
}

const RAW = Buffer.from('{}');
const HEADERS: Record<string, string> = {};

describe('ProcessWebhookEventUseCase', () => {
  it('rejects an invalid signature without touching the DB', async () => {
    const { useCase, insertIfNew } = build({ verify: { kind: 'invalid_signature' } });
    const result = await useCase.execute(RAW, HEADERS);
    expect(result).toEqual({ outcome: 'rejected', reason: 'invalid_signature' });
    expect(insertIfNew).not.toHaveBeenCalled();
  });

  it('rejects an expired timestamp (replay defense) without touching the DB', async () => {
    const { useCase, insertIfNew } = build({ verify: { kind: 'expired_timestamp' } });
    const result = await useCase.execute(RAW, HEADERS);
    expect(result).toEqual({ outcome: 'rejected', reason: 'expired_timestamp' });
    expect(insertIfNew).not.toHaveBeenCalled();
  });

  it('applies a first-delivery success: payment SUCCEEDED + event PROCESSED, intent captured', async () => {
    const { useCase, updateStatus, markProcessed, markSkipped } = build({
      verify: verified(stripeEvent('checkout.session.completed', { intentId: 'pi_123' })),
      existing: payment(PaymentStatus.PENDING),
    });

    const result = await useCase.execute(RAW, HEADERS);

    expect(result).toEqual({
      outcome: 'processed',
      status: PaymentStatus.SUCCEEDED,
      orderId: ORDER_ID,
      paymentRef: 'pi_123',
      eventType: 'checkout.session.completed',
    });
    expect(updateStatus).toHaveBeenCalledWith(
      PAYMENT_ID,
      PaymentStatus.SUCCEEDED,
      expect.objectContaining({ providerIntentId: 'pi_123' }),
    );
    expect(markProcessed).toHaveBeenCalledWith(EVENT_ROW_ID, expect.anything());
    expect(markSkipped).not.toHaveBeenCalled();
  });

  it('threads the SAME transaction handle through insert, lookup, apply, mark, and emit (single-tx effect)', async () => {
    const { useCase, tx, insertIfNew, findByProviderSessionId, updateStatus, markProcessed, append } = build({
      verify: verified(stripeEvent('checkout.session.completed')),
      existing: payment(PaymentStatus.PENDING),
    });

    await useCase.execute(RAW, HEADERS);

    expect(insertIfNew).toHaveBeenCalledWith(expect.anything(), tx);
    expect(findByProviderSessionId).toHaveBeenCalledWith(SESSION_ID, tx);
    expect(updateStatus).toHaveBeenCalledWith(PAYMENT_ID, PaymentStatus.SUCCEEDED, expect.objectContaining({ tx }));
    expect(markProcessed).toHaveBeenCalledWith(EVENT_ROW_ID, tx);
    // The emit belongs in the same unit as the settlement: a payment that commits without its event
    // leaves the order to the sweep alone, which is the failure the outbox exists to remove.
    expect(append).toHaveBeenCalledWith(tx, expect.objectContaining({ eventType: 'payment.succeeded' }));
  });

  it('emits a settlement event carrying the order the consumer has to settle', async () => {
    const { useCase, append } = build({
      verify: verified(stripeEvent('checkout.session.completed', { intentId: 'pi_live_1' })),
      existing: payment(PaymentStatus.PENDING),
    });

    await useCase.execute(RAW, HEADERS);

    const [, record] = append.mock.calls[0];
    expect(record).toMatchObject({
      aggregateType: 'Payment',
      aggregateId: PAYMENT_ID,
      eventType: 'payment.succeeded',
    });
    expect(record.payload).toMatchObject({ orderId: ORDER_ID, paymentRef: 'pi_live_1' });
  });

  it.each([
    ['checkout.session.expired', 'payment.failed'],
    ['checkout.session.completed', 'payment.succeeded'],
  ])('emits %s as %s', async (eventType, expected) => {
    const { useCase, append } = build({
      verify: verified(stripeEvent(eventType)),
      existing: payment(PaymentStatus.PENDING),
    });

    await useCase.execute(RAW, HEADERS);

    expect(append).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: expected }));
  });

  // Every path that leaves the payment where it was: emitting there would drive an order off a
  // settlement that never happened.
  const nonSettling: [string, Partial<Parameters<typeof build>[0]>][] = [
    ['a duplicate delivery', { inserted: false }],
    ['a conflicting transition', { existing: payment(PaymentStatus.SUCCEEDED) }],
    [
      'an uncleared session',
      { verify: verified(stripeEvent('checkout.session.completed', { paymentStatus: 'unpaid' })) },
    ],
  ];

  it.each(nonSettling)('emits nothing for %s', async (_case, overrides) => {
    const { useCase, append } = build({
      verify: verified(stripeEvent('checkout.session.completed')),
      existing: payment(PaymentStatus.PENDING),
      ...overrides,
    });

    await useCase.execute(RAW, HEADERS);

    expect(append).not.toHaveBeenCalled();
  });

  it('maps a failure event to FAILED', async () => {
    const { useCase, updateStatus } = build({
      verify: verified(stripeEvent('checkout.session.expired')),
      existing: payment(PaymentStatus.PENDING),
    });
    const result = await useCase.execute(RAW, HEADERS);
    expect(result).toEqual({
      outcome: 'processed',
      status: PaymentStatus.FAILED,
      orderId: ORDER_ID,
      paymentRef: null,
      eventType: 'checkout.session.expired',
    });
    expect(updateStatus).toHaveBeenCalledWith(PAYMENT_ID, PaymentStatus.FAILED, expect.anything());
  });

  it('no-ops on a duplicate delivery (idempotent, no second apply)', async () => {
    const { useCase, updateStatus, markProcessed, markSkipped, findByProviderSessionId } = build({
      verify: verified(stripeEvent('checkout.session.completed')),
      inserted: false,
      existing: payment(PaymentStatus.PENDING),
    });

    const result = await useCase.execute(RAW, HEADERS);

    expect(result).toEqual({ outcome: 'duplicate' });
    expect(findByProviderSessionId).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
    expect(markProcessed).not.toHaveBeenCalled();
    expect(markSkipped).not.toHaveBeenCalled();
  });

  it('logs but ignores an event type we do not act on', async () => {
    const { useCase, updateStatus, markProcessed, markSkipped } = build({
      verify: verified(stripeEvent('charge.refunded')),
      existing: payment(PaymentStatus.PENDING),
    });
    const result = await useCase.execute(RAW, HEADERS);
    expect(result).toEqual({ outcome: 'ignored' });
    expect(updateStatus).not.toHaveBeenCalled();
    expect(markProcessed).not.toHaveBeenCalled();
    expect(markSkipped).not.toHaveBeenCalled();
  });

  it('skips (no apply) when no payment matches the session yet — the reconciliation seam', async () => {
    const { useCase, updateStatus, markSkipped } = build({
      verify: verified(stripeEvent('checkout.session.completed')),
      existing: null,
    });
    const result = await useCase.execute(RAW, HEADERS);
    expect(result).toEqual({ outcome: 'skipped', reason: 'payment_not_found' });
    expect(markSkipped).toHaveBeenCalledWith(EVENT_ROW_ID, expect.anything());
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('refuses to settle a completed session whose payment has not cleared (async payment method)', async () => {
    const { useCase, updateStatus, markSkipped, markProcessed, findByProviderSessionId } = build({
      verify: verified(stripeEvent('checkout.session.completed', { paymentStatus: 'unpaid' })),
      existing: payment(PaymentStatus.PENDING),
    });

    const result = await useCase.execute(RAW, HEADERS);

    expect(result).toEqual({ outcome: 'skipped', reason: 'awaiting_payment' });
    // Decided from the event alone, so the payment is never even read, let alone moved.
    expect(findByProviderSessionId).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
    expect(markProcessed).not.toHaveBeenCalled();
    expect(markSkipped).toHaveBeenCalledWith(EVENT_ROW_ID, expect.anything());
  });

  it('refuses to settle a completed session that reports no payment_status at all', async () => {
    const { useCase, updateStatus } = build({
      verify: verified(stripeEvent('checkout.session.completed', { paymentStatus: null })),
      existing: payment(PaymentStatus.PENDING),
    });
    const result = await useCase.execute(RAW, HEADERS);
    expect(result).toEqual({ outcome: 'skipped', reason: 'awaiting_payment' });
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('refuses a success whose amount does not match the recorded payment', async () => {
    const { useCase, updateStatus, markProcessed, markSkipped } = build({
      verify: verified(stripeEvent('checkout.session.completed', { amountMinor: 1 })),
      existing: payment(PaymentStatus.PENDING),
    });

    const result = await useCase.execute(RAW, HEADERS);

    expect(result).toEqual({
      outcome: 'skipped',
      reason: 'amount_mismatch',
      charge: {
        orderId: ORDER_ID,
        expectedMinor: AMOUNT_MINOR,
        expectedCurrency: CURRENCY,
        actualMinor: 1,
        actualCurrency: CURRENCY.toLowerCase(),
      },
    });
    expect(updateStatus).not.toHaveBeenCalled();
    expect(markProcessed).not.toHaveBeenCalled();
    expect(markSkipped).toHaveBeenCalledWith(EVENT_ROW_ID, expect.anything());
  });

  it('refuses a success whose currency does not match the recorded payment', async () => {
    const { useCase, updateStatus } = build({
      verify: verified(stripeEvent('checkout.session.completed', { currency: 'usd' })),
      existing: payment(PaymentStatus.PENDING),
    });
    const result = await useCase.execute(RAW, HEADERS);
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'amount_mismatch' });
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('refuses a success that omits the charged amount — absence is not proof', async () => {
    const { useCase, updateStatus } = build({
      verify: verified(stripeEvent('checkout.session.completed', { amountMinor: null })),
      existing: payment(PaymentStatus.PENDING),
    });
    const result = await useCase.execute(RAW, HEADERS);
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'amount_mismatch' });
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('settles an expiry without an amount check — releasing stock must not depend on a charge', async () => {
    const { useCase, updateStatus } = build({
      verify: verified(
        stripeEvent('checkout.session.expired', { paymentStatus: null, amountMinor: null, currency: null }),
      ),
      existing: payment(PaymentStatus.PENDING),
    });
    const result = await useCase.execute(RAW, HEADERS);
    expect(result).toMatchObject({ outcome: 'processed', status: PaymentStatus.FAILED });
    expect(updateStatus).toHaveBeenCalledWith(PAYMENT_ID, PaymentStatus.FAILED, expect.anything());
  });

  it('skips a conflicting transition (failure after success) without clobbering the payment', async () => {
    const { useCase, updateStatus, markSkipped } = build({
      verify: verified(stripeEvent('checkout.session.expired')),
      existing: payment(PaymentStatus.SUCCEEDED),
    });
    const result = await useCase.execute(RAW, HEADERS);
    expect(result).toEqual({
      outcome: 'skipped',
      reason: 'conflict',
      conflict: { orderId: ORDER_ID, from: PaymentStatus.SUCCEEDED, to: PaymentStatus.FAILED },
    });
    expect(markSkipped).toHaveBeenCalledWith(EVENT_ROW_ID, expect.anything());
    expect(updateStatus).not.toHaveBeenCalled();
  });
});
