import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { UnhandledEventError } from '../errors';
import type { DomainEventJob } from '../queue/domain-event.job';
import { DomainEventDispatcher } from './domain-event.dispatcher';
import { OrderEventsHandler } from './order-events.handler';

const tx = Symbol('tx') as unknown as DrizzleTx;

function job(eventType: string): DomainEventJob {
  return {
    outboxId: '0198f0d8-0000-7000-8000-000000000001',
    aggregateType: 'Order',
    aggregateId: '0198f0d8-1111-7000-8000-000000000001',
    eventType,
    payload: {},
    occurredAt: '2026-08-24T00:00:00.000Z',
    traceparent: null,
  };
}

function build() {
  const info = vi.fn();
  const handler = new OrderEventsHandler({ info } as unknown as PinoLogger);
  return { dispatcher: new DomainEventDispatcher(handler), info };
}

describe('DomainEventDispatcher', () => {
  // Every event the order context emits today. A producer that starts emitting a fifth without
  // registering it here should fail this test, not discover it in the dead-letter queue.
  it.each(['order.placed', 'order.paid', 'order.failed', 'order.expired'])('audits %s', async (eventType) => {
    const { dispatcher, info } = build();

    await dispatcher.dispatch(job(eventType), tx);

    expect(info).toHaveBeenCalledWith(expect.objectContaining({ eventType }), 'order event consumed');
  });

  it('refuses an event it has no handler for rather than acknowledging it', async () => {
    const { dispatcher } = build();

    await expect(dispatcher.dispatch(job('payment.succeeded'), tx)).rejects.toBeInstanceOf(UnhandledEventError);
  });

  it('folds an unregistered name into one label, so a bad producer cannot mint time series', () => {
    const { dispatcher } = build();

    expect(dispatcher.label('order.paid')).toBe('order.paid');
    expect(dispatcher.label('order.paid; DROP TABLE')).toBe('unregistered');
  });
});
