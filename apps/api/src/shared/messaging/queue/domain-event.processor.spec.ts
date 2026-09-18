import { describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import type { MetricsPort } from '@shared/observability/metrics/metrics.port';
import { fakePinoLogger } from '@shared/testing/fake-pino-logger';
import type { DomainEventDispatcher } from '../handlers/domain-event.dispatcher';
import type { DomainEventJob, PostCommitEffect } from './domain-event.job';
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

// A fake can prove the effect never runs on a lost claim and that the counter follows the
// transaction's outcome; that the claim itself is atomic is the database's job, and the e2e suite's.
function build({
  claimed = true,
  known = true,
  effect,
  trace = [],
}: { claimed?: boolean; known?: boolean; effect?: PostCommitEffect; trace?: string[] } = {}) {
  const tx = Symbol('tx');
  const transaction = vi.fn(async (run: (t: unknown) => unknown) => {
    const value = await run(tx);
    trace.push('commit');
    return value;
  });
  const claim = vi.fn().mockResolvedValue(claimed);
  const dispatch = vi.fn().mockResolvedValue(effect);
  const label = vi.fn((eventType: string) => (known ? eventType : 'unregistered'));
  const recordEventConsumed = vi.fn();
  const error = vi.fn();
  const logger = fakePinoLogger({ error });

  const processor = new DomainEventProcessor(
    { transaction } as unknown as DrizzleDB,
    { recordEventConsumed } as unknown as MetricsPort,
    { claim },
    { dispatch, label } as unknown as DomainEventDispatcher,
    logger,
  );

  return { processor, tx, claim, dispatch, recordEventConsumed, error };
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

    await ctx.processor.process(job());

    // The 'duplicate' resolution is asserted end to end; the negative and the metric label are not.
    expect(ctx.dispatch).not.toHaveBeenCalled();
    expect(ctx.recordEventConsumed).toHaveBeenCalledWith('order.placed', 'duplicate');
  });

  it('counts a failed consume without claiming it as applied', async () => {
    const ctx = build();
    ctx.dispatch.mockRejectedValueOnce(new Error('handler exploded'));

    await expect(ctx.processor.process(job())).rejects.toThrow('handler exploded');

    // The claim rolls back with the effect, so the outcome must be visible as a failure — silence
    // reads as "nothing arrived" on the dashboard, which is what a stuck event looks like too.
    expect(ctx.recordEventConsumed).toHaveBeenCalledWith('order.placed', 'failed');
  });

  it('folds an unregistered event type into one label', async () => {
    const ctx = build({ known: false });
    ctx.dispatch.mockRejectedValueOnce(new Error('No handler registered'));

    await expect(ctx.processor.process(job({ eventType: 'order.whatever' }))).rejects.toThrow(/No handler/);

    // A name nobody registered is attacker- or typo-controlled; verbatim it would mint unbounded
    // time series in Prometheus.
    expect(ctx.recordEventConsumed).toHaveBeenCalledWith('unregistered', 'failed');
  });

  describe('post-commit effects', () => {
    it('runs the effect only once the transaction has committed', async () => {
      const trace: string[] = [];
      const ctx = build({
        trace,
        effect: () => {
          trace.push('effect');
          return Promise.resolve();
        },
      });

      await expect(ctx.processor.process(job())).resolves.toBe('processed');

      // Reversed, the effect would reach a mail server for a message whose claim then rolled back.
      expect(trace).toEqual(['commit', 'effect']);
    });

    it('does not fail the consume when the effect throws', async () => {
      const ctx = build({ effect: () => Promise.reject(new Error('smtp down')) });

      // The message IS applied — the claim committed — so failing here would only buy a redelivery
      // that the same claim now turns into a no-op.
      await expect(ctx.processor.process(job())).resolves.toBe('processed');
      expect(ctx.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('post-commit'));
    });

    it('runs no effect for a duplicate delivery', async () => {
      const effect = vi.fn().mockResolvedValue(undefined);
      const ctx = build({ claimed: false, effect });

      await expect(ctx.processor.process(job())).resolves.toBe('duplicate');

      expect(effect).not.toHaveBeenCalled();
    });
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
