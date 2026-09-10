import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import type { FinalizeOrderUseCase } from '@modules/order/application/public/order-finalization.port';
import type { MetricsPort } from '@shared/observability/metrics/metrics.port';
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
  const recordRefundOwed = vi.fn();

  const processEvent = { execute: processExec } as unknown as ProcessWebhookEventUseCase;
  const finalizeOrder = { execute: finalizeExec } as unknown as FinalizeOrderUseCase;
  const metrics = { recordRefundOwed } as unknown as MetricsPort;
  const logger = { warn, error } as unknown as PinoLogger;

  const useCase = new HandlePaymentWebhookUseCase(processEvent, finalizeOrder, metrics, logger);
  return { useCase, spies: { processExec, finalizeExec, warn, error, recordRefundOwed } };
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
    ['duplicate', { outcome: 'duplicate' }],
    ['ignored', { outcome: 'ignored' }],
    ['skipped', { outcome: 'skipped', reason: 'payment_not_found' }],
  ] as const)('never finalizes when the payment did not settle (%s)', async (_label, process) => {
    const { useCase, spies } = build({ process });

    const result = await useCase.execute(RAW, HEADERS);

    expect(spies.finalizeExec).not.toHaveBeenCalled();
    expect(result).toBe(process);
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
