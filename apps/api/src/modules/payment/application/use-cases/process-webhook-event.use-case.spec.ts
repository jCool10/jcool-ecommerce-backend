import { describe, expect, it, vi } from 'vitest';
import type { OutboxWriterPort } from '@shared/messaging/outbox/outbox-writer.port';
import { Payment } from '../../domain/payment.entity';
import { PaymentStatus } from '../../domain/payment-status';
import { WebhookEvent } from '../../domain/webhook-event.entity';
import type { VerifiedEvent } from '../ports/payment-gateway.port';
import { fakePaymentGateway, fakePaymentRepository } from '../../testing/payment-port.doubles';
import type { WebhookEventRepositoryPort } from '../ports/webhook-event-repository.port';
import type { TransactionRunnerPort } from '../ports/transaction-runner.port';
import { ProcessWebhookEventUseCase, type WebhookProcessResult } from './process-webhook-event.use-case';

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAYMENT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const EVENT_ROW_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SESSION_ID = 'cs_fake_session';
const AMOUNT_MINOR = 150_000;
const CURRENCY = 'VND';

/**
 * Defaults describe a cleared charge that matches the payment. `null` means the gateway omitted the
 * field entirely, which is distinct from sending a wrong value.
 */
function stripeEvent(
  type: string,
  opts: {
    intentId?: string;
    paymentStatus?: string | null;
    amountMinor?: number | null;
    currency?: string | null;
  } = {},
): VerifiedEvent {
  const object: Record<string, unknown> = { id: SESSION_ID, payment_intent: opts.intentId };
  if (opts.paymentStatus !== null) object.payment_status = opts.paymentStatus ?? 'paid';
  if (opts.amountMinor !== null) object.amount_total = opts.amountMinor ?? AMOUNT_MINOR;
  if (opts.currency !== null) object.currency = opts.currency ?? CURRENCY.toLowerCase();
  return { kind: 'valid', providerEventId: 'evt_1', type, payload: { id: 'evt_1', type, data: { object } } };
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

function build(opts: { verify?: VerifiedEvent; inserted?: boolean; existing?: Payment | null }) {
  const insertIfNew = vi.fn().mockResolvedValue({ inserted: opts.inserted ?? true, event: eventRow() });
  const markProcessed = vi.fn().mockResolvedValue(undefined);
  const markSkipped = vi.fn().mockResolvedValue(undefined);
  const existing = opts.existing === undefined ? payment(PaymentStatus.PENDING) : opts.existing;
  const findByProviderSessionId = vi.fn().mockResolvedValue(existing);
  const updateStatus = vi.fn().mockResolvedValue(existing);
  const verifyAndParseEvent = vi.fn().mockReturnValue(opts.verify ?? stripeEvent('checkout.session.completed'));

  const webhookEvents = { insertIfNew, markProcessed, markSkipped } as unknown as WebhookEventRepositoryPort;
  // Every DB call must receive this exact object to prove the whole unit runs in one transaction.
  const tx = { __tx: true };
  const txRunner = {
    run: vi.fn().mockImplementation((work: (t: unknown) => unknown) => work(tx)),
  } as unknown as TransactionRunnerPort;
  const append = vi.fn<OutboxWriterPort['append']>().mockResolvedValue(undefined);

  const useCase = new ProcessWebhookEventUseCase(
    txRunner,
    fakePaymentGateway({ verifyAndParseEvent }),
    webhookEvents,
    fakePaymentRepository({ findByProviderSessionId, updateStatus }),
    { append },
  );
  return { useCase, tx, insertIfNew, markProcessed, markSkipped, findByProviderSessionId, updateStatus, append };
}

const RAW = Buffer.from('{}');
const HEADERS: Record<string, string> = {};

describe('ProcessWebhookEventUseCase', () => {
  it('settles and emits in the one transaction that recorded the delivery', async () => {
    const { useCase, tx, insertIfNew, findByProviderSessionId, updateStatus, markProcessed, append } = build({
      verify: stripeEvent('checkout.session.completed', { intentId: 'pi_123' }),
    });

    const result = await useCase.execute(RAW, HEADERS);

    expect(result).toEqual({
      outcome: 'processed',
      status: PaymentStatus.SUCCEEDED,
      orderId: ORDER_ID,
      paymentRef: 'pi_123',
      eventType: 'checkout.session.completed',
    });
    expect(insertIfNew).toHaveBeenCalledWith(expect.anything(), tx);
    expect(findByProviderSessionId).toHaveBeenCalledWith(SESSION_ID, tx);
    expect(updateStatus).toHaveBeenCalledWith(
      PAYMENT_ID,
      PaymentStatus.SUCCEEDED,
      expect.objectContaining({ tx, providerIntentId: 'pi_123' }),
    );
    expect(markProcessed).toHaveBeenCalledWith(EVENT_ROW_ID, tx);
    // A payment that commits without its event leaves the order to the sweep alone.
    expect(append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        aggregateId: PAYMENT_ID,
        eventType: 'payment.succeeded',
        payload: expect.objectContaining({ orderId: ORDER_ID, paymentRef: 'pi_123' }) as unknown,
      }),
    );
  });

  // Emitting on any of these would drive an order off a settlement that never happened.
  it('writes and emits nothing for a delivery that does not settle the payment', async () => {
    const completed = (opts: Parameters<typeof stripeEvent>[1]) => stripeEvent('checkout.session.completed', opts);
    const deliveries: Record<string, Parameters<typeof build>[0]> = {
      'invalid signature': { verify: { kind: 'invalid_signature' } },
      'expired timestamp': { verify: { kind: 'expired_timestamp' } },
      duplicate: { inserted: false },
      'unhandled type': { verify: stripeEvent('charge.refunded') },
      'no local payment': { existing: null },
      unpaid: { verify: completed({ paymentStatus: 'unpaid' }) },
      'no payment_status': { verify: completed({ paymentStatus: null }) },
      'wrong amount': { verify: completed({ amountMinor: 1 }) },
      'wrong currency': { verify: completed({ currency: 'usd' }) },
      'no amount': { verify: completed({ amountMinor: null }) },
    };

    const results: Record<string, WebhookProcessResult> = {};
    const outcomes = await Promise.all(
      Object.entries(deliveries).map(async ([label, opts]) => {
        const { useCase, insertIfNew, updateStatus, markProcessed, markSkipped, append } = build(opts);
        const result = await useCase.execute(RAW, HEADERS);
        results[label] = result;
        const verdict = 'reason' in result ? result.reason : result.outcome;
        const recorded = insertIfNew.mock.calls.length > 0;
        const writes = updateStatus.mock.calls.length + markProcessed.mock.calls.length + append.mock.calls.length;
        return [label, verdict, recorded, markSkipped.mock.calls.length, writes];
      }),
    );

    expect(outcomes).toEqual([
      ['invalid signature', 'invalid_signature', false, 0, 0],
      ['expired timestamp', 'expired_timestamp', false, 0, 0],
      ['duplicate', 'duplicate', true, 0, 0],
      ['unhandled type', 'ignored', true, 0, 0],
      ['no local payment', 'payment_not_found', true, 1, 0],
      ['unpaid', 'awaiting_payment', true, 1, 0],
      ['no payment_status', 'awaiting_payment', true, 1, 0],
      ['wrong amount', 'amount_mismatch', true, 1, 0],
      ['wrong currency', 'amount_mismatch', true, 1, 0],
      ['no amount', 'amount_mismatch', true, 1, 0],
    ]);
    // What a human reviewing the unsettled payment needs to see.
    expect(results['wrong amount']).toMatchObject({
      charge: {
        orderId: ORDER_ID,
        expectedMinor: AMOUNT_MINOR,
        expectedCurrency: CURRENCY,
        actualMinor: 1,
        actualCurrency: CURRENCY.toLowerCase(),
      },
    });
  });

  it('settles an expiry without an amount check, since releasing stock must not depend on a charge', async () => {
    const { useCase, updateStatus } = build({
      verify: stripeEvent('checkout.session.expired', { paymentStatus: null, amountMinor: null, currency: null }),
    });

    const result = await useCase.execute(RAW, HEADERS);

    expect(result).toMatchObject({ outcome: 'processed', status: PaymentStatus.FAILED });
    expect(updateStatus).toHaveBeenCalledWith(PAYMENT_ID, PaymentStatus.FAILED, expect.anything());
  });

  it('skips a conflicting transition (failure after success) without clobbering the payment', async () => {
    const { useCase, updateStatus, markSkipped, append } = build({
      verify: stripeEvent('checkout.session.expired'),
      existing: payment(PaymentStatus.SUCCEEDED),
    });

    const result = await useCase.execute(RAW, HEADERS);

    expect(result).toEqual({
      outcome: 'skipped',
      reason: 'conflict',
      providerEventId: 'evt_1',
      eventType: 'checkout.session.expired',
      conflict: { orderId: ORDER_ID, from: PaymentStatus.SUCCEEDED, to: PaymentStatus.FAILED },
    });
    expect(markSkipped).toHaveBeenCalledWith(EVENT_ROW_ID, expect.anything());
    expect(updateStatus).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });
});
