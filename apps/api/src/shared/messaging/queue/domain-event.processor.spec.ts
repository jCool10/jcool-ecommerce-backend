import { describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import type { MetricsPort } from '@jcool/metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { UnhandledEventError } from '../errors';
import type { InboxStore } from '../inbox/inbox.store';
import { dispatcherWith, type DispatcherHandlerDoubles } from '../testing/domain-event-dispatcher.double';
import { sampleId } from '@shared/testing/id-generator.double';
import type { DomainEventJob } from './domain-event.job';
import { DomainEventProcessor } from './domain-event.processor';

const MESSAGE_ID = sampleId(1);
const ORDER_ID = sampleId(2);
const CONSUMER = 'domain-events';

function job(overrides: Partial<DomainEventJob> = {}): DomainEventJob {
  return {
    outboxId: MESSAGE_ID,
    aggregateType: 'Order',
    aggregateId: ORDER_ID,
    eventType: 'order.paid',
    payload: { orderId: ORDER_ID },
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
  const claimedBy: string[] = [];
  const inbox: Pick<InboxStore, 'claim'> = {
    claim: (_tx, { consumer, messageId }) => {
      claimedBy.push(consumer);
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
    inbox as InboxStore,
    dispatcherWith(handlers),
    fakePinoLogger(),
  );
  return { processor, claims, claimedBy, recordEventConsumed };
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

    await expect(processor.process(job(), CONSUMER)).resolves.toBe('processed');

    expect(trace).toEqual(['prepare', 'begin', 'commit', 'effect']);
  });

  // Two consumers of one event each own a claim; a hard-coded name would make the second a duplicate.
  it('claims the message under the consumer it is delivered for', async () => {
    const { processor, claimedBy } = build();

    await processor.process(job({ eventType: 'order.placed' }), 'catalog-search');

    expect(claimedBy).toEqual(['catalog-search']);
  });

  // Retrying an applied message would spend the whole ladder, then dead-letter it.
  it('rejects a failed preparation unless the delivery is a duplicate', async () => {
    const prepareMail = () => vi.fn().mockRejectedValue(new Error('user-service down'));

    const fresh = build({ handlers: { prepareMail: prepareMail() } });
    const duplicate = build({ handlers: { prepareMail: prepareMail() }, alreadyClaimed: true });

    await expect(fresh.processor.process(job(), CONSUMER)).rejects.toThrow('user-service down');
    await expect(duplicate.processor.process(job(), CONSUMER)).resolves.toBe('duplicate');
  });

  it('counts a failed consume under a bounded event label', async () => {
    const closeExpired = vi.fn().mockRejectedValue(new Error('handler exploded'));
    const { processor, recordEventConsumed } = build({ handlers: { closeExpired } });

    await expect(processor.process(job({ eventType: 'order.expired' }), CONSUMER)).rejects.toThrow('handler exploded');
    // A new id, because this fake keeps the claim a real rollback would release.
    const unknownEvent = job({ outboxId: sampleId(3), eventType: 'order.whatever' });
    await expect(processor.process(unknownEvent, CONSUMER)).rejects.toBeInstanceOf(UnhandledEventError);

    expect(recordEventConsumed.mock.calls).toEqual([
      ['order.expired', 'failed'],
      ['unregistered', 'failed'],
    ]);
  });

  it('rejects a malformed envelope before the claim, without echoing its payload', async () => {
    const { processor, claims } = build();

    const rejection = processor.process(job({ eventType: '', payload: { email: 'buyer@example.com' } }), CONSUMER);

    await expect(rejection).rejects.toThrow(/^Malformed domain event envelope/);
    await expect(rejection).rejects.not.toThrow('buyer@example.com');
    expect(claims.size).toBe(0);
  });
});
