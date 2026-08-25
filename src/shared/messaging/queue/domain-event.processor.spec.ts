import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import type { MetricsPort } from '@shared/observability/metrics/metrics.port';
import type { DomainEventDispatcher } from '../handlers/domain-event.dispatcher';
import type { DomainEventJob } from './domain-event.job';
import { DomainEventProcessor } from './domain-event.processor';
import { DOMAIN_EVENTS_CONSUMER } from './queue.constants';

function job(overrides: Partial<DomainEventJob> = {}): DomainEventJob {
  return {
    outboxId: '0198f0d8-0000-7000-8000-000000000001',
    aggregateType: 'Order',
    aggregateId: '0198f0d8-1111-7000-8000-000000000001',
    eventType: 'order.placed',
    payload: { orderId: '0198f0d8-1111-7000-8000-000000000001' },
    occurredAt: '2026-08-24T00:00:00.000Z',
    traceparent: null,
    ...overrides,
  };
}

/**
 * The claim/effect/commit ordering, pinned without a database. What a fake CAN prove here is that
 * the effect never runs on a lost claim and that the counter follows the transaction's outcome;
 * that the claim itself is atomic is the database's job, and the e2e suite's.
 */
function build({ claimed = true, known = true }: { claimed?: boolean; known?: boolean } = {}) {
  const tx = Symbol('tx');
  const transaction = vi.fn((run: (t: unknown) => unknown) => Promise.resolve(run(tx)));
  const claim = vi.fn().mockResolvedValue(claimed);
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const knows = vi.fn().mockReturnValue(known);
  const recordEventConsumed = vi.fn();
  const logger = { debug: vi.fn() } as unknown as PinoLogger;

  const processor = new DomainEventProcessor(
    { transaction } as unknown as DrizzleDB,
    { recordEventConsumed } as unknown as MetricsPort,
    { claim },
    { dispatch, knows } as unknown as DomainEventDispatcher,
    logger,
  );

  return { processor, tx, claim, dispatch, recordEventConsumed };
}

describe('DomainEventProcessor', () => {
  it('claims the message under the consumer group, then runs the effect in the same transaction', async () => {
    const ctx = build();

    await expect(ctx.processor.process(job())).resolves.toBe('processed');

    expect(ctx.claim).toHaveBeenCalledWith(ctx.tx, {
      consumer: DOMAIN_EVENTS_CONSUMER,
      messageId: '0198f0d8-0000-7000-8000-000000000001',
      eventType: 'order.placed',
    });
    // The same handle for both, or the claim could commit while the effect rolls back.
    expect(ctx.dispatch).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'order.placed' }), ctx.tx);
    expect(ctx.recordEventConsumed).toHaveBeenCalledWith('order.placed', 'processed');
  });

  it('skips the effect when the claim was already taken', async () => {
    const ctx = build({ claimed: false });

    await expect(ctx.processor.process(job())).resolves.toBe('duplicate');

    // The whole point of the inbox: a redelivery is acknowledged, never re-applied.
    expect(ctx.dispatch).not.toHaveBeenCalled();
    expect(ctx.recordEventConsumed).toHaveBeenCalledWith('order.placed', 'duplicate');
  });

  it('counts a failed consume without claiming it as applied', async () => {
    const ctx = build();
    ctx.dispatch.mockRejectedValueOnce(new Error('handler exploded'));

    await expect(ctx.processor.process(job())).rejects.toThrow('handler exploded');

    // The claim rolls back with the effect, so the outcome has to be visible as a failure — silence
    // would read as "nothing arrived" on the dashboard, which is exactly what a stuck event looks
    // like from the producer side.
    expect(ctx.recordEventConsumed).toHaveBeenCalledWith('order.placed', 'failed');
  });

  it('folds an unregistered event type into one label', async () => {
    const ctx = build({ known: false });
    ctx.dispatch.mockRejectedValueOnce(new Error('No handler registered'));

    await expect(ctx.processor.process(job({ eventType: 'order.whatever' }))).rejects.toThrow(/No handler/);

    // A name nobody registered is attacker- or typo-controlled; labelling it verbatim would let one
    // bad producer mint unbounded time series in Prometheus.
    expect(ctx.recordEventConsumed).toHaveBeenCalledWith('unregistered', 'failed');
  });

  it('rejects a malformed envelope before opening a transaction', async () => {
    const ctx = build();

    await expect(ctx.processor.process(job({ outboxId: '' }))).rejects.toThrow(/Malformed domain event envelope/);

    expect(ctx.claim).not.toHaveBeenCalled();
  });

  it('keeps the payload out of the malformed-envelope message', async () => {
    const ctx = build();
    const secretish = job({ eventType: '', payload: { email: 'buyer@example.com' } });

    await expect(ctx.processor.process(secretish)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('buyer@example.com') as unknown }) as Error,
    );
  });
});
