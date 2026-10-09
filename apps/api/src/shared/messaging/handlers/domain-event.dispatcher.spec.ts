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
// listed. Payment's and Catalog's are literals in their outbox mappers.
const PRODUCED_EVENT_TYPES = Object.keys({
  'order.placed': true,
  'order.paid': true,
  'order.failed': true,
  'order.expired': true,
  'order.cancelled': true,
  'payment.authorized': true,
  'catalog.product.changed': true,
  'catalog.category.renamed': true,
} satisfies Record<
  | OrderFinalizedEvent['eventName']
  | 'order.placed'
  | 'payment.authorized'
  | 'catalog.product.changed'
  | 'catalog.category.renamed',
  true
>);

const run = async (dispatcher: ReturnType<typeof dispatcherWith>, event: DomainEventJob) =>
  (await dispatcher.prepare(event))(tx);

describe('DomainEventDispatcher', () => {
  it('registers every event type a producer emits', () => {
    const dispatcher = dispatcherWith();

    expect(PRODUCED_EVENT_TYPES.filter((type) => dispatcher.label(type) === 'unregistered')).toEqual([]);
  });

  it.each(['order.placed', 'order.failed', 'order.expired', 'order.cancelled'])(
    'records an audit line for %s and does nothing else with it',
    async (eventType) => {
      const info = vi.fn();
      const event = job(eventType);

      await expect(
        run(dispatcherWith({ orderEvents: new OrderEventsHandler(fakePinoLogger({ info })) }), event),
      ).resolves.toBeUndefined();

      expect(info).toHaveBeenCalledWith(expect.objectContaining({ eventType }), expect.any(String));
    },
  );

  it('records the audit line with the ids a reader correlates on', async () => {
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

  const catalogEvents = [
    ['catalog.product.changed', 'applyProductChanged'],
    ['catalog.category.renamed', 'applyCategoryRenamed'],
  ] as const;

  // A post-commit effect runs after the claim and is never retried; a failed index write must retry.
  it.each(catalogEvents)(
    'writes %s to the search engine before the transaction and leaves the step empty',
    async (eventType, double) => {
      const apply = vi.fn().mockResolvedValue(undefined);
      const dispatcher = dispatcherWith({ [double]: apply });

      const step = await dispatcher.prepare(job(eventType));
      expect(apply).toHaveBeenCalledOnce();

      await expect(step(tx)).resolves.toBeUndefined();
      expect(apply).toHaveBeenCalledOnce();
    },
  );

  it.each(catalogEvents)('fails the prepare when %s cannot be written', async (eventType, double) => {
    const outage = new Error('search engine unavailable');
    const dispatcher = dispatcherWith({ [double]: vi.fn().mockRejectedValue(outage) });

    await expect(dispatcher.prepare(job(eventType))).rejects.toBe(outage);
  });

  it('routes payment.authorized to its handler, whose step runs inside the consumer transaction', async () => {
    const step = vi.fn().mockResolvedValue(undefined);
    const prepareAuthorized = vi.fn().mockResolvedValue(step);
    const event = job('payment.authorized');

    await run(dispatcherWith({ prepareAuthorized }), event);

    expect(prepareAuthorized).toHaveBeenCalledExactlyOnceWith(event);
    expect(step).toHaveBeenCalledExactlyOnceWith(tx);
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
