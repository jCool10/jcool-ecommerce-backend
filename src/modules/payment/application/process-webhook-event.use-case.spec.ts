import { describe, expect, it, vi } from 'vitest';
import { Payment } from '../domain/payment.entity';
import { PaymentStatus } from '../domain/payment-status';
import { WebhookEvent } from '../domain/webhook-event.entity';
import type { PaymentGatewayPort, VerifiedEvent } from './ports/payment-gateway.port';
import type { PaymentRepositoryPort } from './ports/payment-repository.port';
import type { WebhookEventRepositoryPort } from './ports/webhook-event-repository.port';
import type { TransactionRunnerPort } from './ports/transaction-runner.port';
import { ProcessWebhookEventUseCase } from './process-webhook-event.use-case';

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAYMENT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const EVENT_ROW_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SESSION_ID = 'cs_fake_session';

function stripeEvent(
  type: string,
  opts: { id?: string; sessionId?: string; intentId?: string } = {},
): Record<string, unknown> {
  return {
    id: opts.id ?? 'evt_1',
    type,
    data: { object: { id: opts.sessionId ?? SESSION_ID, payment_intent: opts.intentId } },
  };
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
    amountMinor: 150_000,
    currency: 'VND',
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
  const payments = {
    findByProviderSessionId,
    updateStatus,
    findByOrderId: vi.fn(),
    create: vi.fn(),
  } as unknown as PaymentRepositoryPort;
  const gateway = { provider: 'stripe', createSession: vi.fn(), verifyAndParseEvent } as unknown as PaymentGatewayPort;
  // A sentinel tx handle the runner threads into `work`; tests assert every DB call received THIS
  // exact object, proving the insert + apply + mark all run inside the one transaction.
  const tx = { __tx: true };
  const txRunner = {
    run: vi.fn().mockImplementation((work: (t: unknown) => unknown) => work(tx)),
  } as unknown as TransactionRunnerPort;

  const useCase = new ProcessWebhookEventUseCase(txRunner, gateway, webhookEvents, payments);
  return {
    useCase,
    tx,
    insertIfNew,
    markProcessed,
    markSkipped,
    findByProviderSessionId,
    updateStatus,
    verifyAndParseEvent,
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

    expect(result).toEqual({ outcome: 'processed', status: PaymentStatus.SUCCEEDED });
    expect(updateStatus).toHaveBeenCalledWith(
      PAYMENT_ID,
      PaymentStatus.SUCCEEDED,
      expect.objectContaining({ providerIntentId: 'pi_123' }),
    );
    expect(markProcessed).toHaveBeenCalledWith(EVENT_ROW_ID, expect.anything());
    expect(markSkipped).not.toHaveBeenCalled();
  });

  it('threads the SAME transaction handle through insert, lookup, apply, and mark (single-tx effect)', async () => {
    const { useCase, tx, insertIfNew, findByProviderSessionId, updateStatus, markProcessed } = build({
      verify: verified(stripeEvent('checkout.session.completed')),
      existing: payment(PaymentStatus.PENDING),
    });

    await useCase.execute(RAW, HEADERS);

    expect(insertIfNew).toHaveBeenCalledWith(expect.anything(), tx);
    expect(findByProviderSessionId).toHaveBeenCalledWith(SESSION_ID, tx);
    expect(updateStatus).toHaveBeenCalledWith(PAYMENT_ID, PaymentStatus.SUCCEEDED, expect.objectContaining({ tx }));
    expect(markProcessed).toHaveBeenCalledWith(EVENT_ROW_ID, tx);
  });

  it('maps a failure event to FAILED', async () => {
    const { useCase, updateStatus } = build({
      verify: verified(stripeEvent('checkout.session.expired')),
      existing: payment(PaymentStatus.PENDING),
    });
    const result = await useCase.execute(RAW, HEADERS);
    expect(result).toEqual({ outcome: 'processed', status: PaymentStatus.FAILED });
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

  it('skips a conflicting transition (failure after success) without clobbering the payment', async () => {
    const { useCase, updateStatus, markSkipped } = build({
      verify: verified(stripeEvent('checkout.session.expired')),
      existing: payment(PaymentStatus.SUCCEEDED),
    });
    const result = await useCase.execute(RAW, HEADERS);
    expect(result).toEqual({ outcome: 'skipped', reason: 'conflict' });
    expect(markSkipped).toHaveBeenCalledWith(EVENT_ROW_ID, expect.anything());
    expect(updateStatus).not.toHaveBeenCalled();
  });
});
