import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { describe, expect, it, vi } from 'vitest';
import type { OrderFinalizedEvent } from '@modules/order/domain/order.entity';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { UnhandledEventError } from '../errors';
import type { DomainEventJob } from '../queue/domain-event.job';
import { dispatcherWith } from '../testing/domain-event-dispatcher.double';
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

// Order's finalized events come from its domain type, so a new one fails typecheck here until it is
// listed. Payment's two are literals in its outbox mapper.
const PRODUCED_EVENT_TYPES = Object.keys({
  'order.placed': true,
  'order.paid': true,
  'order.failed': true,
  'order.expired': true,
  'order.cancelled': true,
  'payment.succeeded': true,
  'payment.failed': true,
} satisfies Record<OrderFinalizedEvent['eventName'] | 'order.placed' | 'payment.succeeded' | 'payment.failed', true>);

const run = async (dispatcher: ReturnType<typeof dispatcherWith>, event: DomainEventJob) =>
  (await dispatcher.prepare(event))(tx);

describe('DomainEventDispatcher', () => {
  it('registers every event type a producer emits', () => {
    const dispatcher = dispatcherWith();

    expect(PRODUCED_EVENT_TYPES.filter((type) => dispatcher.label(type) === 'unregistered')).toEqual([]);
  });

  it('records an audit line for an order event it has nothing else to do for', async () => {
    const info = vi.fn();
    const event = job('order.placed');

    await run(dispatcherWith({ orderEvents: new OrderEventsHandler(fakePinoLogger({ info })) }), event);

    expect(info).toHaveBeenCalledWith(
      {
        eventType: 'order.placed',
        orderId: event.aggregateId,
        messageId: event.outboxId,
        occurredAt: event.occurredAt,
      },
      expect.any(String),
    );
  });

  // The address can come from another service, and that call must not hold the consumer's connection.
  it('prepares the order.paid mail before the transaction and hands it back unsent', async () => {
    const sendMail = vi.fn();
    const prepareMail = vi.fn().mockResolvedValue(sendMail);
    const dispatcher = dispatcherWith({ prepareMail });

    const step = await dispatcher.prepare(job('order.paid'));
    expect(prepareMail).toHaveBeenCalledOnce();

    await expect(step(tx)).resolves.toBe(sendMail);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('runs each effectful event on its own handler inside the consumer transaction', async () => {
    const settle = vi.fn();
    const closeExpired = vi.fn();
    const closeCancelled = vi.fn();
    const dispatcher = dispatcherWith({ settle, closeExpired, closeCancelled });

    for (const eventType of ['order.expired', 'order.cancelled', 'payment.succeeded', 'payment.failed']) {
      await run(dispatcher, job(eventType));
    }

    const routed = (handler: typeof settle) =>
      handler.mock.calls.map(([event, onTx]) => [(event as DomainEventJob).eventType, onTx === tx]);
    expect({ expired: routed(closeExpired), cancelled: routed(closeCancelled), settled: routed(settle) }).toEqual({
      expired: [['order.expired', true]],
      cancelled: [['order.cancelled', true]],
      settled: [
        ['payment.succeeded', true],
        ['payment.failed', true],
      ],
    });
  });

  // Swallowed, the inbox claim would commit and the checkout session would stay open for good.
  it('fails the consume when the payment session cannot be closed', async () => {
    const unreachable = () => vi.fn().mockRejectedValue(new Error('gateway unreachable'));
    const dispatcher = dispatcherWith({ closeExpired: unreachable(), closeCancelled: unreachable() });

    await expect(run(dispatcher, job('order.expired'))).rejects.toThrow('gateway unreachable');
    await expect(run(dispatcher, job('order.cancelled'))).rejects.toThrow('gateway unreachable');
  });

  it('refuses an event it has no handler for', async () => {
    await expect(dispatcherWith().prepare(job('cart.abandoned'))).rejects.toBeInstanceOf(UnhandledEventError);
  });

  // A name off the wire is unbounded; as a metric label it would mint a time series per value.
  it('folds an unregistered event type into one label', () => {
    const dispatcher = dispatcherWith();

    expect(['order.paid', 'order.paid; DROP TABLE'].map((type) => dispatcher.label(type))).toEqual([
      'order.paid',
      'unregistered',
    ]);
  });
});
