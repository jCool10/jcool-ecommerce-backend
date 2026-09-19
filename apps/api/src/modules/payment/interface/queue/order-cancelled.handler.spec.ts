import { describe, expect, it, vi } from 'vitest';
import type { DrizzleTx } from '@shared/infrastructure/database';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import type { ExpirePaymentSessionUseCase } from '../../application/use-cases';
import { OrderCancelledHandler } from './order-cancelled.handler';

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tx = Symbol('tx') as unknown as DrizzleTx;

function job(payload: Record<string, unknown> = { orderId: ORDER_ID }): DomainEventJob {
  return {
    outboxId: '0198f0d8-0000-7000-8000-000000000001',
    aggregateType: 'Order',
    aggregateId: ORDER_ID,
    eventType: 'order.cancelled',
    payload,
    occurredAt: '2026-09-07T10:00:00.000Z',
    traceparent: null,
  };
}

function build() {
  const execute = vi.fn().mockResolvedValue('expired');
  const handler = new OrderCancelledHandler({ execute } as unknown as ExpirePaymentSessionUseCase);
  return { handler, execute };
}

describe('OrderCancelledHandler', () => {
  // The trigger is the whole reason this handler exists separately: it is what makes the refund line
  // say a buyer pressed cancel rather than that a sweep timed the order out.
  it('closes the session on the consumer tx, tagged as a cancel', async () => {
    const { handler, execute } = build();

    await handler.close(job(), tx);

    expect(execute).toHaveBeenCalledWith(ORDER_ID, tx, 'cancel');
  });

  // Permanent rather than retryable: the payload is identical on every redelivery, and a guessed
  // orderId would expire some other buyer's live checkout session.
  it.each([{}, { orderId: 42 }, { orderId: null }])('refuses an unusable payload %j permanently', async (payload) => {
    const { handler, execute } = build();

    await expect(handler.close(job(payload), tx)).rejects.toBeInstanceOf(PermanentError);
    expect(execute).not.toHaveBeenCalled();
  });

  // The gateway is unreachable exactly when these pile up, so the failure must take the consumer's
  // transaction — and the inbox claim it holds — down with it.
  it('propagates a gateway failure so the redelivery retries the close', async () => {
    const { handler, execute } = build();
    execute.mockRejectedValue(new Error('gateway unreachable'));

    await expect(handler.close(job(), tx)).rejects.toThrow('gateway unreachable');
  });
});
