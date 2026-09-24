import { describe, expect, it, vi } from 'vitest';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { FinalizeOrderUseCase } from '../../application/use-cases';
import { PaymentEventsHandler } from './payment-events.handler';

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tx = Symbol('tx') as unknown as DrizzleTx;

type FinalizeStatus = 'finalized' | 'noop' | 'ignored' | 'not_found';

function job(eventType: string, payload: Record<string, unknown> = { orderId: ORDER_ID }): DomainEventJob {
  return {
    outboxId: '0198f0d8-0000-7000-8000-000000000001',
    aggregateType: 'Payment',
    aggregateId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    eventType,
    payload,
    occurredAt: '2026-08-26T10:00:00.000Z',
    traceparent: null,
  };
}

function build(status: FinalizeStatus = 'finalized', reportFinalized?: () => void) {
  const execute = vi.fn().mockResolvedValue({ status, order: { status: 'EXPIRED' }, reportFinalized });
  const metrics = fakeMetricsPort();
  const handler = new PaymentEventsHandler({ execute } as unknown as FinalizeOrderUseCase, metrics, fakePinoLogger());
  return { handler, execute, metrics };
}

describe('PaymentEventsHandler', () => {
  it('settles the order named in payment.failed as FAILED, passing only a string handle', async () => {
    const { handler, execute } = build();

    await handler.settle(job('payment.failed', { orderId: ORDER_ID, paymentRef: 'pi_1' }), tx);
    await handler.settle(job('payment.failed', { orderId: ORDER_ID, paymentRef: 42 }), tx);

    expect(execute.mock.calls).toEqual([
      [{ orderId: ORDER_ID, outcome: 'FAILED', paymentRef: 'pi_1', reason: 'event:payment.failed' }, tx],
      [{ orderId: ORDER_ID, outcome: 'FAILED', paymentRef: null, reason: 'event:payment.failed' }, tx],
    ]);
  });

  it('rejects an event type it does not settle permanently, without settling anything', async () => {
    const { handler, execute } = build();

    await expect(handler.settle(job('payment.refunded'), tx)).rejects.toBeInstanceOf(PermanentError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('counts a refund owed only for a successful payment that settled no order', async () => {
    const cases: Array<[string, FinalizeStatus]> = [
      ['payment.succeeded', 'ignored'],
      ['payment.succeeded', 'not_found'],
      ['payment.succeeded', 'noop'],
      ['payment.failed', 'ignored'],
      ['payment.failed', 'not_found'],
    ];

    const outcomes = await Promise.all(
      cases.map(async ([eventType, status]) => {
        const { handler, metrics } = build(status);
        await handler.settle(job(eventType), tx);
        return [eventType, status, metrics.recordRefundOwed.mock.calls];
      }),
    );

    expect(outcomes).toEqual([
      ['payment.succeeded', 'ignored', [['settlement_event']]],
      ['payment.succeeded', 'not_found', [['settlement_event']]],
      ['payment.succeeded', 'noop', []],
      ['payment.failed', 'ignored', []],
      ['payment.failed', 'not_found', []],
    ]);
  });

  it('defers the finalize reporting to after the consumer commits', async () => {
    const report = vi.fn();
    const { handler } = build('finalized', report);

    const effect = await handler.settle(job('payment.succeeded'), tx);

    expect(report).not.toHaveBeenCalled();
    expect(effect).toBeTypeOf('function');
    await effect?.();
    expect(report).toHaveBeenCalledOnce();
  });
});
