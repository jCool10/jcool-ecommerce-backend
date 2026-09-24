import { describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import type { MetricsPort } from '@jcool/metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { UnhandledEventError } from '../errors';
import type { InboxStore } from '../inbox/inbox.store';
import { dispatcherWith, type DispatcherHandlerDoubles } from '../testing/domain-event-dispatcher.double';
import type { DomainEventJob } from './domain-event.job';
import { DomainEventProcessor } from './domain-event.processor';

const MESSAGE_ID = '0198f0d8-0000-7000-8000-000000000001';

function job(overrides: Partial<DomainEventJob> = {}): DomainEventJob {
  return {
    outboxId: MESSAGE_ID,
    aggregateType: 'Order',
    aggregateId: '0198f0d8-1111-7000-8000-000000000001',
    eventType: 'order.paid',
    payload: { orderId: '0198f0d8-1111-7000-8000-000000000001' },
    occurredAt: '2026-08-24T00:00:00.000Z',
    traceparent: null,
    ...overrides,
  };
}

interface BuildOptions {
  handlers?: DispatcherHandlerDoubles;
  alreadyClaimed?: boolean;
  trace?: string[];
}

// Atomicity of the claim is the database's job and the e2e suite's; this fake only remembers ids.
function build({ handlers = {}, alreadyClaimed = false, trace = [] }: BuildOptions = {}) {
  const claims = new Set<string>(alreadyClaimed ? [MESSAGE_ID] : []);
  const inbox: InboxStore = {
    claim: (_tx, { messageId }) => {
      if (claims.has(messageId)) return Promise.resolve(false);
      claims.add(messageId);
      return Promise.resolve(true);
    },
  };
  const transaction = async (run: (tx: unknown) => unknown) => {
    trace.push('begin');
    const value = await run(Symbol('tx'));
    trace.push('commit');
    return value;
  };
  const recordEventConsumed = vi.fn();

  const processor = new DomainEventProcessor(
    { transaction } as unknown as DrizzleDB,
    { recordEventConsumed } as unknown as MetricsPort,
    inbox,
    dispatcherWith(handlers),
    fakePinoLogger(),
  );
  return { processor, claims, recordEventConsumed };
}

describe('DomainEventProcessor', () => {
  // Reversed, the effect would reach a mail server for a message whose claim then rolled back.
  it('runs the effect only once the transaction has committed', async () => {
    const trace: string[] = [];
    const prepareMail = vi.fn(() => {
      trace.push('prepare');
      return Promise.resolve(() => {
        trace.push('effect');
        return Promise.resolve();
      });
    });
    const { processor } = build({ handlers: { prepareMail }, trace });

    await expect(processor.process(job())).resolves.toBe('processed');

    expect(trace).toEqual(['prepare', 'begin', 'commit', 'effect']);
  });

  // Retrying an applied message would spend the whole ladder, then dead-letter it.
  it('rejects a failed preparation unless the delivery is a duplicate', async () => {
    const prepareMail = () => vi.fn().mockRejectedValue(new Error('user-service down'));

    const fresh = build({ handlers: { prepareMail: prepareMail() } });
    const duplicate = build({ handlers: { prepareMail: prepareMail() }, alreadyClaimed: true });

    await expect(fresh.processor.process(job())).rejects.toThrow('user-service down');
    await expect(duplicate.processor.process(job())).resolves.toBe('duplicate');
  });

  it('counts a failed consume under a bounded event label', async () => {
    const closeExpired = vi.fn().mockRejectedValue(new Error('handler exploded'));
    const { processor, recordEventConsumed } = build({ handlers: { closeExpired } });

    await expect(processor.process(job({ eventType: 'order.expired' }))).rejects.toThrow('handler exploded');
    // A new id, because this fake keeps the claim a real rollback would release.
    const unknownEvent = job({ outboxId: '0198f0d8-0000-7000-8000-000000000002', eventType: 'order.whatever' });
    await expect(processor.process(unknownEvent)).rejects.toBeInstanceOf(UnhandledEventError);

    expect(recordEventConsumed.mock.calls).toEqual([
      ['order.expired', 'failed'],
      ['unregistered', 'failed'],
    ]);
  });

  it('rejects a malformed envelope before the claim, without echoing its payload', async () => {
    const { processor, claims } = build();

    const rejection = processor.process(job({ eventType: '', payload: { email: 'buyer@example.com' } }));

    await expect(rejection).rejects.toThrow(/^Malformed domain event envelope/);
    await expect(rejection).rejects.not.toThrow('buyer@example.com');
    expect(claims.size).toBe(0);
  });
});
