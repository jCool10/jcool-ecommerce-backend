import { describe, expect, it, vi } from 'vitest';
import type { DrizzleTx } from '@shared/infrastructure/database';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import type { ExpirePaymentSessionUseCase } from '../../application/use-cases';
import { OrderCancelledHandler } from './order-cancelled.handler';

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tx = Symbol('tx') as unknown as DrizzleTx;

function job(payload: Record<string, unknown>): DomainEventJob {
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

describe('OrderCancelledHandler', () => {
  // The payload is identical on every redelivery, and a guessed orderId would expire some other
  // buyer's live checkout session.
  it('refuses a payload with no usable orderId permanently, closing nothing', async () => {
    const execute = vi.fn();
    const handler = new OrderCancelledHandler({ execute } as unknown as ExpirePaymentSessionUseCase);

    for (const payload of [{}, { orderId: 42 }, { orderId: null }]) {
      await expect(handler.close(job(payload), tx)).rejects.toBeInstanceOf(PermanentError);
    }
    expect(execute).not.toHaveBeenCalled();
  });
});
