import { describe, expect, it, vi } from 'vitest';
import type { FinalizeOrderUseCase } from '@modules/order/application/public/order-finalization.port';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { PaymentStatus } from '../../domain/payment-status';
import { HandlePaymentWebhookUseCase } from './handle-payment-webhook.use-case';
import type { ProcessWebhookEventUseCase, WebhookProcessResult } from './process-webhook-event.use-case';

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RAW = Buffer.from('{}');
const HEADERS: Record<string, string> = { 'stripe-signature': 't=1,v1=deadbeef' };

const processedSuccess: WebhookProcessResult = {
  outcome: 'processed',
  status: PaymentStatus.SUCCEEDED,
  orderId: ORDER_ID,
  paymentRef: 'pi_123',
  eventType: 'checkout.session.completed',
};

function build(opts: { process: WebhookProcessResult; finalize?: unknown; finalizeThrows?: unknown }) {
  const processExec = vi.fn().mockResolvedValue(opts.process);
  const finalizeExec = opts.finalizeThrows
    ? vi.fn().mockRejectedValue(opts.finalizeThrows)
    : vi.fn().mockResolvedValue(opts.finalize ?? { status: 'finalized' });
  const warn = vi.fn();
  const error = vi.fn();
  const debug = vi.fn();
  const info = vi.fn();
  const recordRefundOwed = vi.fn();

  const processEvent = { execute: processExec } as unknown as ProcessWebhookEventUseCase;
  const finalizeOrder = { execute: finalizeExec } as unknown as FinalizeOrderUseCase;
  const metrics = fakeMetricsPort({ recordRefundOwed });
  const logger = fakePinoLogger({ warn, error, debug, info });

  const useCase = new HandlePaymentWebhookUseCase(processEvent, finalizeOrder, metrics, logger);
  return { useCase, spies: { processExec, finalizeExec, warn, error, debug, info, recordRefundOwed } };
}

describe('HandlePaymentWebhookUseCase', () => {
  it('finalizes the order PAID on a settled success, threading paymentRef and a webhook reason', async () => {
    const { useCase, spies } = build({ process: processedSuccess });

    const result = await useCase.execute(RAW, HEADERS);

    expect(spies.processExec).toHaveBeenCalledWith(RAW, HEADERS);
    expect(spies.finalizeExec).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      outcome: 'PAID',
      paymentRef: 'pi_123',
      reason: 'webhook:checkout.session.completed',
    });
    // The HTTP contract stays the payment-side outcome; the order finalize is a side effect.
    expect(result).toBe(processedSuccess);
  });

  it('finalizes the order FAILED on a settled failure', async () => {
    const process: WebhookProcessResult = {
      outcome: 'processed',
      status: PaymentStatus.FAILED,
      orderId: ORDER_ID,
      paymentRef: null,
      eventType: 'checkout.session.expired',
    };
    const { useCase, spies } = build({ process });

    await useCase.execute(RAW, HEADERS);

    expect(spies.finalizeExec).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      outcome: 'FAILED',
      paymentRef: null,
      reason: 'webhook:checkout.session.expired',
    });
  });

  it.each([
    ['rejected', { outcome: 'rejected', reason: 'invalid_signature' }],
    ['duplicate', { outcome: 'duplicate', providerEventId: 'evt_1', eventType: 'checkout.session.completed' }],
    ['ignored', { outcome: 'ignored', providerEventId: 'evt_1', eventType: 'charge.refunded' }],
    [
      'skipped',
      {
        outcome: 'skipped',
        reason: 'payment_not_found',
        providerEventId: 'evt_1',
        eventType: 'checkout.session.completed',
      },
    ],
  ] as const)('never finalizes when the payment did not settle (%s)', async (_label, process) => {
    const { useCase, spies } = build({ process });

    const result = await useCase.execute(RAW, HEADERS);

    expect(spies.finalizeExec).not.toHaveBeenCalled();
    expect(result).toBe(process);
  });

  it('logs a debug line for a duplicate delivery, carrying the event that was redelivered', async () => {
    const process: WebhookProcessResult = {
      outcome: 'duplicate',
      providerEventId: 'evt_dup',
      eventType: 'checkout.session.completed',
    };
    const { useCase, spies } = build({ process });

    await useCase.execute(RAW, HEADERS);

    expect(spies.debug).toHaveBeenCalledExactlyOnceWith(
      { outcome: 'duplicate', providerEventId: 'evt_dup', eventType: 'checkout.session.completed' },
      'webhook event accepted but not applied',
    );
    expect(spies.info).not.toHaveBeenCalled();
    expect(spies.error).not.toHaveBeenCalled();
  });

  it('logs a debug line for an event type we do not act on', async () => {
    const process: WebhookProcessResult = {
      outcome: 'ignored',
      providerEventId: 'evt_ignored',
      eventType: 'charge.refunded',
    };
    const { useCase, spies } = build({ process });

    await useCase.execute(RAW, HEADERS);

    expect(spies.debug).toHaveBeenCalledExactlyOnceWith(
      { outcome: 'ignored', providerEventId: 'evt_ignored', eventType: 'charge.refunded' },
      'webhook event accepted but not applied',
    );
  });

  it('logs an info line for a harmless skip with no conflict/charge (payment not found yet)', async () => {
    const process: WebhookProcessResult = {
      outcome: 'skipped',
      reason: 'payment_not_found',
      providerEventId: 'evt_no_payment',
      eventType: 'checkout.session.completed',
    };
    const { useCase, spies } = build({ process });

    await useCase.execute(RAW, HEADERS);

    expect(spies.info).toHaveBeenCalledExactlyOnceWith(
      {
        outcome: 'skipped',
        reason: 'payment_not_found',
        providerEventId: 'evt_no_payment',
        eventType: 'checkout.session.completed',
      },
      'webhook event accepted but not applied',
    );
    expect(spies.debug).not.toHaveBeenCalled();
    expect(spies.error).not.toHaveBeenCalled();
    expect(spies.recordRefundOwed).not.toHaveBeenCalled();
  });

  it('logs an info line (not error) for a conflict that never touched money — a late failure after success', async () => {
    const process: WebhookProcessResult = {
      outcome: 'skipped',
      reason: 'conflict',
      providerEventId: 'evt_late_failure',
      eventType: 'checkout.session.expired',
      conflict: { orderId: ORDER_ID, from: PaymentStatus.SUCCEEDED, to: PaymentStatus.FAILED },
    };
    const { useCase, spies } = build({ process });

    await useCase.execute(RAW, HEADERS);

    expect(spies.info).toHaveBeenCalledExactlyOnceWith(
      {
        outcome: 'skipped',
        reason: 'conflict',
        providerEventId: 'evt_late_failure',
        eventType: 'checkout.session.expired',
        conflict: { orderId: ORDER_ID, from: PaymentStatus.SUCCEEDED, to: PaymentStatus.FAILED },
      },
      'webhook event accepted but not applied',
    );
    expect(spies.error).not.toHaveBeenCalled();
    expect(spies.recordRefundOwed).not.toHaveBeenCalled();
  });

  it('swallows a finalize failure and still acks (order left for reconciliation)', async () => {
    const boom = new Error('db unreachable');
    const { useCase, spies } = build({ process: processedSuccess, finalizeThrows: boom });

    const result = await useCase.execute(RAW, HEADERS);

    expect(result).toBe(processedSuccess); // 2xx path preserved; no throw
    expect(spies.error).toHaveBeenCalledTimes(1);
  });

  // No sweep picks this up — reconcile's queue is orders still PENDING — so a payment that moved
  // money onto an order that did not move is a refund decision, not a wait-and-see.
  it.each(['not_found', 'ignored'] as const)(
    'raises a successful payment whose finalize was a %s at error level',
    async (status) => {
      const { useCase, spies } = build({ process: processedSuccess, finalize: { status } });

      await useCase.execute(RAW, HEADERS);

      expect(spies.error).toHaveBeenCalledTimes(1);
      expect(spies.warn).not.toHaveBeenCalled();
    },
  );
});
