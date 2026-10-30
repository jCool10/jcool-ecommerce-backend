import { describe, expect, it, vi } from 'vitest';
import { type DomainEventJob, UnhandledEventError, eventLabel } from '@jcool/messaging';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { dispatcherWith } from '../testing/domain-event-dispatcher.double';

const tx = Symbol('tx') as unknown as DrizzleTx;

function job(eventType: string): DomainEventJob {
  return {
    outboxId: '0198f0d8-0000-7000-8000-000000000001',
    aggregateType: 'Product',
    aggregateId: '0198f0d8-1111-7000-8000-000000000001',
    eventType,
    payload: {},
    occurredAt: '2026-08-24T00:00:00.000Z',
    traceparent: null,
  };
}

// Catalog's are literals in its outbox mapper.
const PRODUCED_EVENT_TYPES = Object.keys({
  'catalog.product.changed': true,
  'catalog.category.renamed': true,
} satisfies Record<'catalog.product.changed' | 'catalog.category.renamed', true>);

describe('DomainEventDispatcher', () => {
  it('registers every event type a producer emits', () => {
    const dispatcher = dispatcherWith();

    expect(PRODUCED_EVENT_TYPES.filter((type) => !dispatcher.handles(type))).toEqual([]);
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

  it('refuses an event it has no handler for', async () => {
    await expect(dispatcherWith().prepare(job('cart.abandoned'))).rejects.toBeInstanceOf(UnhandledEventError);
    // The order-service consumes these now.
    await expect(dispatcherWith().prepare(job('order.placed'))).rejects.toBeInstanceOf(UnhandledEventError);
  });

  // A name off the wire is unbounded; as a metric label it would mint a time series per value.
  it('folds an unregistered event type into one label', () => {
    const dispatcher = dispatcherWith();

    expect(
      ['catalog.product.changed', 'catalog.product.changed; DROP TABLE'].map((type) => eventLabel(dispatcher, type)),
    ).toEqual(['catalog.product.changed', 'unregistered']);
  });
});
