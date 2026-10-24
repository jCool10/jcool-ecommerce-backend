import { describe, expect, it, vi } from 'vitest';
import { WebhookEvent } from '../../domain/webhook-event.entity';
import type { VerifiedEvent } from '../ports/payment-gateway.port';
import { fakePaymentGateway } from '../../testing/payment-port.doubles';
import type { WebhookEventRepositoryPort } from '../ports/webhook-event-repository.port';
import type { TransactionRunnerPort } from '../ports/transaction-runner.port';
import { ProcessWebhookEventUseCase } from './process-webhook-event.use-case';
import type { ProcessTccWebhookEventUseCase, TccWebhookResult } from './process-tcc-webhook-event.use-case';

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EVENT_ROW_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SESSION_ID = 'cs_fake_session';

function stripeEvent(type: string, paymentStatus?: string): VerifiedEvent {
  const object: Record<string, unknown> = { id: SESSION_ID, payment_intent: 'pi_123', amount_total: 150_000 };
  if (paymentStatus !== undefined) object.payment_status = paymentStatus;
  return { kind: 'valid', providerEventId: 'evt_1', type, payload: { id: 'evt_1', type, data: { object } } };
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

function build(opts: { verify?: VerifiedEvent; inserted?: boolean; tcc?: TccWebhookResult | null } = {}) {
  const insertIfNew = vi.fn().mockResolvedValue({ inserted: opts.inserted ?? true, event: eventRow() });
  const markProcessed = vi.fn().mockResolvedValue(undefined);
  const markSkipped = vi.fn().mockResolvedValue(undefined);
  const verifyAndParseEvent = vi.fn().mockReturnValue(opts.verify ?? stripeEvent('checkout.session.completed', 'paid'));

  const webhookEvents = { insertIfNew, markProcessed, markSkipped } as unknown as WebhookEventRepositoryPort;
  const tx = { __tx: true };
  const txRunner = {
    run: vi.fn().mockImplementation((work: (t: unknown) => unknown) => work(tx)),
  } as unknown as TransactionRunnerPort;
  const tccExecute = vi.fn<ProcessTccWebhookEventUseCase['execute']>().mockResolvedValue(opts.tcc ?? null);

  const useCase = new ProcessWebhookEventUseCase(txRunner, fakePaymentGateway({ verifyAndParseEvent }), webhookEvents, {
    execute: tccExecute,
  } as unknown as ProcessTccWebhookEventUseCase);
  return { useCase, tx, insertIfNew, markProcessed, markSkipped, tccExecute };
}

const RAW = Buffer.from('{}');
const HEADERS: Record<string, string> = {};

describe('ProcessWebhookEventUseCase', () => {
  it('hands a participant payment to the TCC path and logs nothing itself', async () => {
    const tcc: TccWebhookResult = {
      path: 'tcc',
      outcome: 'processed',
      orderId: ORDER_ID,
      providerEventId: 'evt_1',
      eventType: 'checkout.session.completed',
    };
    const { useCase, tccExecute, insertIfNew } = build({ tcc });

    await expect(useCase.execute(RAW, HEADERS)).resolves.toBe(tcc);

    expect(tccExecute).toHaveBeenCalledWith(expect.objectContaining({ kind: 'valid', providerEventId: 'evt_1' }));
    expect(insertIfNew).not.toHaveBeenCalled();
  });

  it('never asks the TCC path about a delivery that failed verification', async () => {
    const { useCase, tccExecute } = build({ verify: { kind: 'invalid_signature' } });

    await useCase.execute(RAW, HEADERS);
    expect(tccExecute).not.toHaveBeenCalled();
  });

  it('logs a session with no payment header as skipped, in the transaction that recorded it', async () => {
    const { useCase, tx, insertIfNew, markSkipped, markProcessed } = build();

    const result = await useCase.execute(RAW, HEADERS);

    expect(result).toEqual({
      outcome: 'skipped',
      reason: 'no_payment_header',
      providerEventId: 'evt_1',
      eventType: 'checkout.session.completed',
      sessionId: SESSION_ID,
      moneyMoved: true,
    });
    expect(insertIfNew).toHaveBeenCalledWith(expect.objectContaining({ providerEventId: 'evt_1' }), tx);
    expect(markSkipped).toHaveBeenCalledExactlyOnceWith(EVENT_ROW_ID, tx);
    expect(markProcessed).not.toHaveBeenCalled();
  });

  // Only a cleared charge leaves money to hand back; an unpaid or expired session moved none.
  it('flags money as moved only for a completed session that cleared', async () => {
    const deliveries: Array<[string, VerifiedEvent]> = [
      ['paid', stripeEvent('checkout.session.completed', 'paid')],
      ['nothing due', stripeEvent('checkout.session.completed', 'no_payment_required')],
      ['unpaid', stripeEvent('checkout.session.completed', 'unpaid')],
      ['no payment_status', stripeEvent('checkout.session.completed')],
      ['expired', stripeEvent('checkout.session.expired')],
    ];

    const outcomes = await Promise.all(
      deliveries.map(async ([label, verify]) => {
        const result = await build({ verify }).useCase.execute(RAW, HEADERS);
        return [label, 'moneyMoved' in result ? result.moneyMoved : result.outcome];
      }),
    );

    expect(outcomes).toEqual([
      ['paid', true],
      ['nothing due', false],
      ['unpaid', false],
      ['no payment_status', false],
      ['expired', false],
    ]);
  });

  it('writes nothing past the event log for a delivery it does not act on', async () => {
    const deliveries: Record<string, Parameters<typeof build>[0]> = {
      'invalid signature': { verify: { kind: 'invalid_signature' } },
      'expired timestamp': { verify: { kind: 'expired_timestamp' } },
      duplicate: { inserted: false },
      'unhandled type': { verify: stripeEvent('charge.refunded') },
    };

    const outcomes = await Promise.all(
      Object.entries(deliveries).map(async ([label, opts]) => {
        const { useCase, insertIfNew, markSkipped, markProcessed } = build(opts);
        const result = await useCase.execute(RAW, HEADERS);
        const verdict = 'reason' in result ? result.reason : result.outcome;
        return [
          label,
          verdict,
          insertIfNew.mock.calls.length,
          markSkipped.mock.calls.length + markProcessed.mock.calls.length,
        ];
      }),
    );

    expect(outcomes).toEqual([
      ['invalid signature', 'invalid_signature', 0, 0],
      ['expired timestamp', 'expired_timestamp', 0, 0],
      ['duplicate', 'duplicate', 1, 0],
      ['unhandled type', 'ignored', 1, 0],
    ]);
  });
});
