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

function settled(status: PaymentStatus): WebhookProcessResult {
  return {
    outcome: 'processed',
    status,
    orderId: ORDER_ID,
    paymentRef: 'pi_123',
    eventType: 'checkout.session.completed',
  };
}

function build(process: WebhookProcessResult, finalize = () => Promise.resolve<unknown>({ status: 'finalized' })) {
  const finalizeExec = vi.fn().mockImplementation(finalize);
  const metrics = fakeMetricsPort();
  const error = vi.fn();
  const useCase = new HandlePaymentWebhookUseCase(
    { execute: vi.fn().mockResolvedValue(process) } as unknown as ProcessWebhookEventUseCase,
    { execute: finalizeExec } as unknown as FinalizeOrderUseCase,
    metrics,
    fakePinoLogger({ error }),
  );
  return { useCase, finalizeExec, metrics, error };
}

// No sweep picks these up (reconcile's queue is orders still PENDING), so money that moved with no
// order moving is a refund decision, not a wait-and-see.
describe('HandlePaymentWebhookUseCase', () => {
  it('books a refund when a settled success moves no order', async () => {
    const cases: Array<[PaymentStatus, string]> = [
      [PaymentStatus.SUCCEEDED, 'not_found'],
      [PaymentStatus.SUCCEEDED, 'ignored'],
      [PaymentStatus.SUCCEEDED, 'finalized'],
      [PaymentStatus.FAILED, 'ignored'],
    ];

    const outcomes = await Promise.all(
      cases.map(async ([status, finalizeStatus]) => {
        const { useCase, metrics } = build(settled(status), () => Promise.resolve({ status: finalizeStatus }));
        await useCase.execute(RAW, HEADERS);
        return [status, finalizeStatus, metrics.recordRefundOwed.mock.calls];
      }),
    );

    expect(outcomes).toEqual([
      [PaymentStatus.SUCCEEDED, 'not_found', [['webhook_direct']]],
      [PaymentStatus.SUCCEEDED, 'ignored', [['webhook_direct']]],
      [PaymentStatus.SUCCEEDED, 'finalized', []],
      [PaymentStatus.FAILED, 'ignored', []],
    ]);
  });

  it('never finalizes an unsettled delivery, booking a refund only for a success after a failure', async () => {
    const skipped = { outcome: 'skipped', providerEventId: 'evt_1', eventType: 'checkout.session.completed' } as const;
    const deliveries: Record<string, WebhookProcessResult> = {
      rejected: { outcome: 'rejected', reason: 'invalid_signature' },
      duplicate: { outcome: 'duplicate', providerEventId: 'evt_1', eventType: 'checkout.session.completed' },
      ignored: { outcome: 'ignored', providerEventId: 'evt_1', eventType: 'charge.refunded' },
      'payment not found': { ...skipped, reason: 'payment_not_found' },
      'failure after success': {
        ...skipped,
        reason: 'conflict',
        conflict: { orderId: ORDER_ID, from: PaymentStatus.SUCCEEDED, to: PaymentStatus.FAILED },
      },
      'success after failure': {
        ...skipped,
        reason: 'conflict',
        conflict: { orderId: ORDER_ID, from: PaymentStatus.FAILED, to: PaymentStatus.SUCCEEDED },
      },
      // A repeat notice of the outcome the payment already settled to — reconcile or an earlier
      // delivery got there first. Idempotent, not a conflict: no refund booked, no error logged.
      'repeat notice of the already-settled outcome': { ...skipped, reason: 'already_settled' },
    };

    const outcomes = await Promise.all(
      Object.entries(deliveries).map(async ([label, process]) => {
        const { useCase, finalizeExec, metrics } = build(process);
        const result = await useCase.execute(RAW, HEADERS);
        return [label, result === process, finalizeExec.mock.calls.length, metrics.recordRefundOwed.mock.calls];
      }),
    );

    expect(outcomes).toEqual([
      ['rejected', true, 0, []],
      ['duplicate', true, 0, []],
      ['ignored', true, 0, []],
      ['payment not found', true, 0, []],
      ['failure after success', true, 0, []],
      ['success after failure', true, 0, [['webhook_direct']]],
      ['repeat notice of the already-settled outcome', true, 0, []],
    ]);
  });

  // Booking no refund is not enough on its own: this used to fall through the SUCCEEDED conflict
  // branch, which also logs at error level regardless of refund.
  it('logs nothing at error level for a repeat notice of the already-settled outcome', async () => {
    const process: WebhookProcessResult = {
      outcome: 'skipped',
      reason: 'already_settled',
      providerEventId: 'evt_1',
      eventType: 'checkout.session.completed',
    };
    const { useCase, error } = build(process);

    await useCase.execute(RAW, HEADERS);

    expect(error).not.toHaveBeenCalled();
  });

  // The payment tx already committed, so a 5xx would buy only a retry storm; the settlement event
  // settles the order instead.
  it('swallows a finalize failure and still acks (order left for reconciliation)', async () => {
    const process = settled(PaymentStatus.SUCCEEDED);
    const { useCase, error } = build(process, () => Promise.reject(new Error('db unreachable')));

    await expect(useCase.execute(RAW, HEADERS)).resolves.toBe(process);
    expect(error).toHaveBeenCalledOnce();
  });
});
