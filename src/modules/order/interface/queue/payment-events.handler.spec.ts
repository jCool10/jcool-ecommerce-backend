import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import type { MetricsPort } from '@shared/observability/metrics/metrics.port';
import type { FinalizeOrderUseCase } from '../../application/use-cases';
import { PaymentEventsHandler } from './payment-events.handler';

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tx = Symbol('tx') as unknown as DrizzleTx;

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

function build(
  status: 'finalized' | 'noop' | 'ignored' | 'not_found' = 'finalized',
  orderStatus?: string,
  reportFinalized?: () => void,
) {
  const execute = vi
    .fn()
    .mockResolvedValue({ status, order: orderStatus ? { status: orderStatus } : undefined, reportFinalized });
  const error = vi.fn();
  const info = vi.fn();
  const recordRefundOwed = vi.fn();
  const handler = new PaymentEventsHandler(
    { execute } as unknown as FinalizeOrderUseCase,
    { recordRefundOwed } as unknown as MetricsPort,
    {
      error,
      info,
    } as unknown as PinoLogger,
  );
  return { handler, execute, error, info, recordRefundOwed };
}

describe('PaymentEventsHandler', () => {
  // Only the failed→FAILED mapping is asserted here: no e2e ever consumes a `payment.failed` event
  // onto a still-PENDING order, so this is the sole coverage of that half of OUTCOME_BY_EVENT.
  it('settles the order named in payment.failed as FAILED', async () => {
    const { handler, execute } = build();

    await handler.settle(job('payment.failed', { orderId: ORDER_ID, paymentRef: 'pi_1' }), tx);

    expect(execute).toHaveBeenCalledWith(
      { orderId: ORDER_ID, outcome: 'FAILED', paymentRef: 'pi_1', reason: 'event:payment.failed' },
      tx,
    );
  });

  it('treats a missing gateway handle as no handle rather than passing the raw value through', async () => {
    const { handler, execute } = build();

    await handler.settle(job('payment.succeeded', { orderId: ORDER_ID, paymentRef: 42 }), tx);

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ paymentRef: null }), tx);
  });

  // Only the unsettleable-event-type half of the guard is asserted here: the dispatcher routes just
  // `payment.succeeded` and `payment.failed` to this handler, so no e2e can reach `outcome ===
  // undefined`. The unreadable-orderId half is proven end to end instead.
  it('rejects an event type it does not settle permanently, without settling anything', async () => {
    const { handler, execute } = build();

    await expect(handler.settle(job('payment.refunded', { orderId: ORDER_ID }), tx)).rejects.toBeInstanceOf(
      PermanentError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  // A redelivery after the webhook already settled the order the same way — the ordinary case for a
  // path that exists to be at-least-once.
  it('accepts a noop finalize quietly', async () => {
    const { handler, error, info } = build('noop');

    await expect(handler.settle(job('payment.succeeded'), tx)).resolves.toBeUndefined();

    expect(error).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  // The TTL sweep expiring an order out from under a payment that then succeeds: no retry recovers
  // stock already resold, so the only useful move is to put a refund decision in front of a human.
  it('raises a successful payment onto an already-terminal order at error level', async () => {
    const { handler, error } = build('ignored', 'EXPIRED');

    await expect(handler.settle(job('payment.succeeded'), tx)).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, status: 'EXPIRED' }),
      'payment settled for an order that was already in a terminal state',
    );
  });

  // The settlement lives in the consumer's transaction, so its counters and audit line may only run
  // once that has committed — which is what returning them as a post-commit effect buys.
  it('defers the finalize reporting to after the consumer commits', async () => {
    const report = vi.fn();
    const { handler } = build('finalized', undefined, report);

    const effect = await handler.settle(job('payment.succeeded'), tx);

    expect(report).not.toHaveBeenCalled();
    expect(effect).toBeTypeOf('function');
    await effect?.();
    expect(report).toHaveBeenCalledOnce();
  });

  it('returns no post-commit effect for a settlement that moved nothing', async () => {
    const { handler } = build('noop');

    await expect(handler.settle(job('payment.succeeded'), tx)).resolves.toBeUndefined();
  });

  it('records a failed payment onto an already-terminal order without alarm', async () => {
    const { handler, error, info } = build('ignored', 'EXPIRED');

    await handler.settle(job('payment.failed'), tx);

    expect(error).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ orderId: ORDER_ID }), expect.any(String));
  });
});
