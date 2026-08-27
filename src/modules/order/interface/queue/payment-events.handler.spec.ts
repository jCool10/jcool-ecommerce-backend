import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
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

function build(status: 'finalized' | 'noop' | 'ignored' | 'not_found' = 'finalized') {
  const execute = vi.fn().mockResolvedValue({ status });
  const error = vi.fn();
  const handler = new PaymentEventsHandler(
    { execute } as unknown as FinalizeOrderUseCase,
    {
      error,
    } as unknown as PinoLogger,
  );
  return { handler, execute, error };
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

  // A redelivery after the webhook already settled the order, and a late failure after a success:
  // finalize decides both, and neither is the consumer's problem to retry.
  it.each(['noop', 'ignored'] as const)('accepts a %s finalize quietly', async (status) => {
    const { handler, error } = build(status);

    await expect(handler.settle(job('payment.succeeded'), tx)).resolves.toBeUndefined();

    expect(error).not.toHaveBeenCalled();
  });
});
