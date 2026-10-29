import { describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { HandlePaymentWebhookUseCase } from './handle-payment-webhook.use-case';
import type { ProcessWebhookEventUseCase, WebhookProcessResult } from './process-webhook-event.use-case';
import type { TccWebhookResult } from './process-tcc-webhook-event.use-case';

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RAW = Buffer.from('{}');
const HEADERS: Record<string, string> = { 'stripe-signature': 't=1,v1=deadbeef' };

function headerless(moneyMoved: boolean): WebhookProcessResult {
  return {
    outcome: 'skipped',
    reason: 'no_payment_header',
    providerEventId: 'evt_1',
    eventType: 'checkout.session.completed',
    sessionId: 'cs_1',
    moneyMoved,
  };
}

function build(process: WebhookProcessResult | TccWebhookResult) {
  const metrics = fakeMetricsPort();
  const error = vi.fn();
  const useCase = new HandlePaymentWebhookUseCase(
    { execute: vi.fn().mockResolvedValue(process) } as unknown as ProcessWebhookEventUseCase,
    metrics,
    fakePinoLogger({ error }),
  );
  return { useCase, metrics, error };
}

describe('HandlePaymentWebhookUseCase', () => {
  it('books nothing for a participant payment, whatever the outcome', async () => {
    for (const outcome of ['processed', 'skipped', 'duplicate'] as const) {
      const tcc: TccWebhookResult = {
        path: 'tcc',
        outcome,
        orderId: ORDER_ID,
        providerEventId: 'evt_1',
        eventType: 'checkout.session.completed',
      };
      const { useCase, metrics } = build(tcc);

      await expect(useCase.execute(RAW, HEADERS)).resolves.toBe(tcc);
      expect(metrics.recordRefundOwed).not.toHaveBeenCalled();
    }
  });

  // No saga owns that session, so nothing will ever capture or void it on our side.
  it('books a refund for a cleared charge on a session without a payment header', async () => {
    const process = headerless(true);
    const { useCase, metrics, error } = build(process);

    await expect(useCase.execute(RAW, HEADERS)).resolves.toBe(process);

    expect(metrics.recordRefundOwed).toHaveBeenCalledExactlyOnceWith('webhook_direct');
    expect(error).toHaveBeenCalledOnce();
  });

  it('books nothing for a delivery that moved no money', async () => {
    const deliveries: WebhookProcessResult[] = [
      headerless(false),
      { outcome: 'rejected', reason: 'invalid_signature' },
      { outcome: 'duplicate', providerEventId: 'evt_1', eventType: 'checkout.session.completed' },
      { outcome: 'ignored', providerEventId: 'evt_1', eventType: 'charge.refunded' },
    ];

    for (const process of deliveries) {
      const { useCase, metrics, error } = build(process);

      await expect(useCase.execute(RAW, HEADERS)).resolves.toBe(process);
      expect(metrics.recordRefundOwed).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    }
  });
});
