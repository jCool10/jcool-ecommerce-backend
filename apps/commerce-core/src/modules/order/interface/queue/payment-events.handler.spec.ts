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
  it.each([
    ['payment.succeeded', 'PAID'],
    ['payment.failed', 'FAILED'],
  ])('settles the order named in %s as %s', async (eventType, outcome) => {
    const { handler, execute } = build();

    await handler.settle(job(eventType, { orderId: ORDER_ID, paymentRef: 'pi_1' }), tx);

    expect(execute).toHaveBeenCalledWith(
      { orderId: ORDER_ID, outcome, paymentRef: 'pi_1', reason: `event:${eventType}` },
      tx,
    );
  });

  // Without this the claim would commit on its own and the redelivery would find the message
  // consumed with the order never settled.
  it('runs the finalize on the consumer transaction it was handed', async () => {
    const { handler, execute } = build();

    await handler.settle(job('payment.succeeded'), tx);

    expect(execute).toHaveBeenCalledWith(expect.anything(), tx);
  });

  it('treats a missing gateway handle as no handle rather than passing the raw value through', async () => {
    const { handler, execute } = build();

    await handler.settle(job('payment.succeeded', { orderId: ORDER_ID, paymentRef: 42 }), tx);

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ paymentRef: null }), tx);
  });

  it.each([
    ['an order id of the wrong type', 'payment.succeeded', { orderId: 42 }],
    ['no order id at all', 'payment.succeeded', {}],
    ['an event type it does not settle', 'payment.refunded', { orderId: ORDER_ID }],
  ])('rejects %s permanently, without settling anything', async (_case, eventType, payload) => {
    const { handler, execute } = build();

    await expect(handler.settle(job(eventType, payload), tx)).rejects.toBeInstanceOf(PermanentError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('acknowledges a settlement whose order is gone, and says so at error level', async () => {
    const { handler, error } = build('not_found');

    await expect(handler.settle(job('payment.succeeded'), tx)).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID }),
      'payment settled for an order that does not exist',
    );
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
