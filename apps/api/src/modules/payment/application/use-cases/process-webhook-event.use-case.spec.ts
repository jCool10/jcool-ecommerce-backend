import { describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { OutboxWriterPort } from '@shared/messaging/outbox/outbox-writer.port';
import { Payment } from '../../domain/payment.entity';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentStatus } from '../../domain/payment-status';
import { WebhookEvent } from '../../domain/webhook-event.entity';
import { PaymentGatewayError, type SessionAuthorization, type VerifiedEvent } from '../ports/payment-gateway.port';
import {
  fakePaymentGateway,
  fakePaymentOrderRepository,
  fakePaymentRepository,
} from '../../testing/payment-port.doubles';
import type { WebhookEventRepositoryPort } from '../ports/webhook-event-repository.port';
import type { TransactionRunnerPort } from '../ports/transaction-runner.port';
import { ApplyTccWebhookEventUseCase } from './apply-tcc-webhook-event.use-case';
import { ProcessWebhookEventUseCase, type WebhookProcessResult } from './process-webhook-event.use-case';
import { RecordAuthorizationUseCase } from './record-authorization.use-case';

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

const EVENT_ID = '7400000000000000011';
const OUTBOX_ID = '7400000000000000012';

/** A payment with no `payment_orders` header: a session opened before the saga owned checkout. */
function build(opts: { verify?: VerifiedEvent; inserted?: boolean; existing?: Payment | null }) {
  const calls: string[] = [];
  let inTx = false;
  const tx = { __tx: true };
  const run = vi.fn(async (work: (t: unknown) => Promise<unknown>) => {
    calls.push('tx');
    inTx = true;
    try {
      return await work(tx);
    } finally {
      inTx = false;
    }
  });
  const mint = vi.fn((count: number = 1) => {
    calls.push(inTx ? 'mint inside tx' : 'mint');
    return Promise.resolve([EVENT_ID].slice(0, count));
  });
  const insertIfNew = vi.fn().mockResolvedValue({ inserted: opts.inserted ?? true, event: eventRow() });
  const markProcessed = vi.fn().mockResolvedValue(undefined);
  const markSkipped = vi.fn().mockResolvedValue(undefined);
  const existing = opts.existing === undefined ? payment(PaymentStatus.PENDING) : opts.existing;
  const findByProviderSessionId = vi.fn().mockResolvedValue(existing);
  const updateStatus = vi.fn().mockResolvedValue(existing);
  const verifyAndParseEvent = vi.fn().mockReturnValue(opts.verify ?? stripeEvent('checkout.session.completed'));
  const recordRefundOwed = vi.fn();
  const logError = vi.fn();
  const applyTcc = vi.fn();

  const useCase = new ProcessWebhookEventUseCase(
    { run } as unknown as TransactionRunnerPort,
    fakePaymentGateway({ verifyAndParseEvent }),
    { insertIfNew, markProcessed, markSkipped } as unknown as WebhookEventRepositoryPort,
    fakePaymentRepository({ findByProviderSessionId, updateStatus }),
    fakePaymentOrderRepository({ find: vi.fn().mockResolvedValue(null) }),
    { mint },
    { execute: applyTcc } as unknown as ApplyTccWebhookEventUseCase,
    fakeMetricsPort({ recordRefundOwed }),
    fakePinoLogger({ error: logError }),
  );
  return {
    useCase,
    tx,
    calls,
    insertIfNew,
    markProcessed,
    markSkipped,
    updateStatus,
    recordRefundOwed,
    logError,
    applyTcc,
  };
}
const HOLD: SessionAuthorization = {
  sessionStatus: 'complete',
  intentId: 'pi_1',
  intentStatus: 'requires_capture',
  amountCapturableMinor: AMOUNT_MINOR,
  currency: CURRENCY.toLowerCase(),
};

/** A payment opened behind a `payment_orders` header, wired through the real recorder. */
function buildFenced(opts: {
  verify?: VerifiedEvent;
  inserted?: boolean;
  authorization?: SessionAuthorization | Error;
}) {
  const calls: string[] = [];
  let inTx = false;
  const tx = { __tx: true };
  const run = vi.fn(async (work: (t: unknown) => Promise<unknown>) => {
    calls.push('tx');
    inTx = true;
    try {
      return await work(tx);
    } finally {
      inTx = false;
    }
  });
  const mint = vi.fn((count: number = 1) => {
    calls.push(inTx ? 'mint inside tx' : 'mint');
    return Promise.resolve([EVENT_ID, OUTBOX_ID].slice(0, count));
  });
  const authorization = opts.authorization ?? HOLD;
  const retrieveAuthorization = vi.fn(() => {
    calls.push('retrieve');
    return authorization instanceof Error ? Promise.reject(authorization) : Promise.resolve(authorization);
  });
  const verifyAndParseEvent = vi
    .fn()
    .mockReturnValue(opts.verify ?? stripeEvent('checkout.session.completed', { paymentStatus: 'unpaid' }));
  const insertIfNew = vi.fn().mockResolvedValue({ inserted: opts.inserted ?? true, event: eventRow() });
  const markProcessed = vi.fn().mockResolvedValue(undefined);
  const markSkipped = vi.fn().mockResolvedValue(undefined);
  const header = { orderId: ORDER_ID, status: PaymentOrderStatus.OPEN, amountMinor: AMOUNT_MINOR, currency: CURRENCY };
  const updateHeader = vi.fn().mockResolvedValue(true);
  const findByProviderSessionId = vi.fn().mockResolvedValue(payment(PaymentStatus.PENDING));
  const updateStatus = vi.fn().mockResolvedValue({});
  const append = vi.fn<OutboxWriterPort['append']>().mockResolvedValue(undefined);

  const txRunner = { run } as unknown as TransactionRunnerPort;
  const gateway = fakePaymentGateway({ verifyAndParseEvent, retrieveAuthorization });
  const webhookEvents = { insertIfNew, markProcessed, markSkipped } as unknown as WebhookEventRepositoryPort;
  const headers = fakePaymentOrderRepository({
    find: vi.fn().mockResolvedValue(header),
    findForUpdate: vi.fn().mockResolvedValue(header),
    updateStatus: updateHeader,
  });
  const payments = fakePaymentRepository({ findByProviderSessionId, updateStatus });
  const recorder = new RecordAuthorizationUseCase(headers, payments, { append }, fakePinoLogger());
  const useCase = new ProcessWebhookEventUseCase(
    txRunner,
    gateway,
    webhookEvents,
    payments,
    headers,
    { mint },
    new ApplyTccWebhookEventUseCase(txRunner, gateway, webhookEvents, payments, { mint }, recorder),
    fakeMetricsPort(),
    fakePinoLogger(),
  );
  return {
    useCase,
    tx,
    calls,
    run,
    mint,
    retrieveAuthorization,
    insertIfNew,
    markProcessed,
    markSkipped,
    updateHeader,
    findByProviderSessionId,
    updateStatus,
    append,
  };
}

const RAW = Buffer.from('{}');
const HEADERS: Record<string, string> = {};

describe('ProcessWebhookEventUseCase', () => {
  describe('for a payment with no header', () => {
    it('logs the delivery as skipped without touching the payment, minting the id before the transaction', async () => {
      const { useCase, tx, calls, insertIfNew, markSkipped, markProcessed, updateStatus, applyTcc } = build({
        verify: stripeEvent('checkout.session.expired', { paymentStatus: 'unpaid' }),
      });

      await expect(useCase.execute(RAW, HEADERS)).resolves.toEqual({
        outcome: 'skipped',
        reason: 'unfenced',
        providerEventId: 'evt_1',
        eventType: 'checkout.session.expired',
        orderId: ORDER_ID,
        captured: false,
      });
      expect(calls).toEqual(['mint', 'tx']);
      expect(insertIfNew).toHaveBeenCalledWith(expect.anything(), tx, EVENT_ID);
      expect(markSkipped).toHaveBeenCalledWith(EVENT_ID, tx);
      expect(markProcessed).not.toHaveBeenCalled();
      expect(updateStatus).not.toHaveBeenCalled();
      expect(applyTcc).not.toHaveBeenCalled();
    });

    // No order settles against such a session any more, so money it captured is money owed back.
    it('books a refund owed, once, for a capture on it', async () => {
      const first = build({});
      const redelivery = build({ inserted: false });

      await expect(first.useCase.execute(RAW, HEADERS)).resolves.toMatchObject({ reason: 'unfenced', captured: true });
      await expect(redelivery.useCase.execute(RAW, HEADERS)).resolves.toMatchObject({ outcome: 'duplicate' });

      expect(first.recordRefundOwed).toHaveBeenCalledExactlyOnceWith('webhook_direct');
      expect(first.logError).toHaveBeenCalledOnce();
      expect(redelivery.recordRefundOwed).not.toHaveBeenCalled();
    });

    it('books nothing when no money moved', async () => {
      const completed = (opts: Parameters<typeof stripeEvent>[1]) => stripeEvent('checkout.session.completed', opts);
      const deliveries: Record<string, VerifiedEvent> = {
        unpaid: completed({ paymentStatus: 'unpaid' }),
        'no payment_status': completed({ paymentStatus: null }),
        'no payment required': completed({ paymentStatus: 'no_payment_required' }),
        expiry: stripeEvent('checkout.session.expired', { paymentStatus: null }),
      };

      const outcomes = await Promise.all(
        Object.entries(deliveries).map(async ([label, verify]) => {
          const { useCase, recordRefundOwed, logError } = build({ verify });
          const result = await useCase.execute(RAW, HEADERS);
          return [
            label,
            'captured' in result && result.captured,
            recordRefundOwed.mock.calls.length,
            logError.mock.calls.length,
          ];
        }),
      );

      expect(outcomes).toEqual([
        ['unpaid', false, 0, 0],
        ['no payment_status', false, 0, 0],
        ['no payment required', false, 0, 0],
        ['expiry', false, 0, 0],
      ]);
    });
  });

  it('writes nothing to a payment for a delivery it cannot place', async () => {
    const deliveries: Record<string, Parameters<typeof build>[0]> = {
      'invalid signature': { verify: { kind: 'invalid_signature' } },
      'expired timestamp': { verify: { kind: 'expired_timestamp' } },
      duplicate: { inserted: false },
      'unhandled type': { verify: stripeEvent('charge.refunded') },
      'no local payment': { existing: null },
    };

    const outcomes = await Promise.all(
      Object.entries(deliveries).map(async ([label, opts]) => {
        const { useCase, insertIfNew, updateStatus, markProcessed, markSkipped, recordRefundOwed } = build(opts);
        const result: WebhookProcessResult = await useCase.execute(RAW, HEADERS);
        const verdict = 'reason' in result ? result.reason : result.outcome;
        const writes = updateStatus.mock.calls.length + markProcessed.mock.calls.length;
        return [
          label,
          verdict,
          insertIfNew.mock.calls.length > 0,
          markSkipped.mock.calls.length,
          writes,
          recordRefundOwed.mock.calls.length,
        ];
      }),
    );

    expect(outcomes).toEqual([
      ['invalid signature', 'invalid_signature', false, 0, 0, 0],
      ['expired timestamp', 'expired_timestamp', false, 0, 0, 0],
      ['duplicate', 'duplicate', true, 0, 0, 0],
      // Left RECEIVED: logged for audit, never a candidate for application.
      ['unhandled type', 'ignored', true, 0, 0, 0],
      ['no local payment', 'payment_not_found', true, 1, 0, 0],
    ]);
  });

  describe('for a payment opened behind a header', () => {
    // Stripe never sends a settlement for a manual-capture session: completed means a hold was placed.
    it('records the hold and announces it, never as a settlement, minting every id before the transaction', async () => {
      const { useCase, tx, calls, insertIfNew, updateStatus, updateHeader, markProcessed, append } = buildFenced({});

      await expect(useCase.execute(RAW, HEADERS)).resolves.toEqual({
        outcome: 'processed',
        status: PaymentStatus.AUTHORIZED,
        orderId: ORDER_ID,
        paymentRef: 'pi_1',
        eventType: 'checkout.session.completed',
      });
      expect(calls).toEqual(['retrieve', 'mint', 'tx']);
      expect(insertIfNew).toHaveBeenCalledWith(expect.anything(), tx, EVENT_ID);
      expect(updateStatus).toHaveBeenCalledWith(
        PAYMENT_ID,
        PaymentStatus.AUTHORIZED,
        expect.objectContaining({ tx, providerIntentId: 'pi_1', expectedStatus: PaymentStatus.PENDING }),
      );
      expect(updateHeader).toHaveBeenCalledWith(tx, ORDER_ID, PaymentOrderStatus.AUTHORIZED, PaymentOrderStatus.OPEN);
      expect(markProcessed).toHaveBeenCalledWith(EVENT_ID, tx);
      expect(append).toHaveBeenCalledExactlyOnceWith(
        tx,
        expect.objectContaining({ eventType: 'payment.authorized' }),
        OUTBOX_ID,
      );
    });

    // Without the row Stripe's redelivery is processed; with it, the redelivery would dedup to nothing.
    it('answers unavailable without logging the delivery when Stripe cannot be read', async () => {
      const { useCase, run, mint } = buildFenced({ authorization: new PaymentGatewayError('breaker open') });

      await expect(useCase.execute(RAW, HEADERS)).resolves.toEqual({
        outcome: 'unavailable',
        providerEventId: 'evt_1',
        eventType: 'checkout.session.completed',
      });
      expect(mint).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    });

    it('logs a completed session whose hold is not placed yet, leaving the payment for the sweep', async () => {
      const { useCase, markSkipped, updateStatus, append } = buildFenced({
        authorization: { sessionStatus: 'complete', intentId: 'pi_1', intentStatus: 'processing' },
      });

      await expect(useCase.execute(RAW, HEADERS)).resolves.toMatchObject({
        outcome: 'skipped',
        reason: 'awaiting_payment',
      });
      expect(markSkipped).toHaveBeenCalledWith(EVENT_ID, expect.anything());
      expect(updateStatus).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
    });

    it('expires the payment on a session expiry, leaving the header and the outbox alone', async () => {
      const { useCase, tx, calls, findByProviderSessionId, updateStatus, updateHeader, markProcessed, append } =
        buildFenced({ verify: stripeEvent('checkout.session.expired', { paymentStatus: 'unpaid' }) });

      await expect(useCase.execute(RAW, HEADERS)).resolves.toMatchObject({
        outcome: 'processed',
        status: PaymentStatus.EXPIRED,
      });
      expect(calls).toEqual(['mint', 'tx']);
      expect(findByProviderSessionId).toHaveBeenCalledWith(SESSION_ID, tx);
      expect(updateStatus).toHaveBeenCalledWith(PAYMENT_ID, PaymentStatus.EXPIRED, {
        tx,
        expectedStatus: PaymentStatus.PENDING,
      });
      expect(markProcessed).toHaveBeenCalledWith(EVENT_ID, tx);
      expect(updateHeader).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
    });

    it('treats a redelivery as a duplicate without touching the payment', async () => {
      const { useCase, updateStatus, append } = buildFenced({ inserted: false });

      await expect(useCase.execute(RAW, HEADERS)).resolves.toMatchObject({ outcome: 'duplicate' });
      expect(updateStatus).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
    });
  });
});
