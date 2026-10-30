import { describe, expect, it, vi } from 'vitest';
import type { MetricsPort } from '@jcool/metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { UnhandledEventError } from '../errors';
import type { InboxEntry, InboxStore } from '../inbox/inbox.store';
import type { MessagingDb } from '../messaging.database';
import { type FakeHandler, consumersOf, fakeDispatcher, inTransaction } from '../testing/fake-dispatcher';
import { CATALOG, ORDERS, sampleId } from '../testing/messaging-fixtures';
import type { DomainEventJob } from './domain-event.job';
import { DomainEventProcessor } from './domain-event.processor';

const MESSAGE_ID = sampleId(1);
const ORDER_ID = sampleId(2);

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
  handlers?: Record<string, FakeHandler>;
  alreadyClaimed?: boolean;
  trace?: string[];
}

const DEFAULT_HANDLERS: Record<string, FakeHandler> = {
  'order.paid': inTransaction(),
  'order.expired': inTransaction(),
};

// Atomicity of the claim is the database's job and the e2e suite's; this fake only remembers ids.
function build({ handlers = {}, alreadyClaimed = false, trace = [] }: BuildOptions = {}) {
  const claimed: InboxEntry[] = [];
  const claims = new Set<string>(alreadyClaimed ? [`orders:${MESSAGE_ID}`] : []);
  const inbox: Pick<InboxStore, 'claim'> = {
    claim: (_tx, entry) => {
      const key = `${entry.consumer}:${entry.messageId}`;
      if (claims.has(key)) return Promise.resolve(false);
      claims.add(key);
      claimed.push(entry);
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
  const dispatcher = fakeDispatcher({ ...DEFAULT_HANDLERS, ...handlers });

  const processor = new DomainEventProcessor(
    { transaction } as unknown as MessagingDb,
    { recordEventConsumed } as unknown as MetricsPort,
    inbox as InboxStore,
    consumersOf({ spec: ORDERS, dispatcher }, { spec: CATALOG, consumer: 'catalog-sync', dispatcher }),
    fakePinoLogger(),
  );
  return { processor, claims, claimed, recordEventConsumed };
}

describe('DomainEventProcessor', () => {
  // Reversed, the effect would reach a mail server for a message whose claim then rolled back.
  it('runs the effect only once the transaction has committed', async () => {
    const trace: string[] = [];
    const prepareMail: FakeHandler = () => {
      trace.push('prepare');
      return Promise.resolve(() =>
        Promise.resolve(() => {
          trace.push('effect');
          return Promise.resolve();
        }),
      );
    };
    const { processor } = build({ handlers: { 'order.paid': prepareMail }, trace });

    await expect(processor.process(job(), 'orders')).resolves.toBe('processed');

    expect(trace).toEqual(['prepare', 'begin', 'commit', 'effect']);
  });

  // Retrying an applied message would spend the whole ladder, then dead-letter it.
  it('rejects a failed preparation unless the delivery is a duplicate', async () => {
    const prepareMail = (): FakeHandler => vi.fn().mockRejectedValue(new Error('user-service down'));

    const fresh = build({ handlers: { 'order.paid': prepareMail() } });
    const duplicate = build({ handlers: { 'order.paid': prepareMail() }, alreadyClaimed: true });

    await expect(fresh.processor.process(job(), 'orders')).rejects.toThrow('user-service down');
    await expect(duplicate.processor.process(job(), 'orders')).resolves.toBe('duplicate');
  });

  it('counts a failed consume under a bounded event label', async () => {
    const record = vi.fn().mockRejectedValue(new Error('handler exploded'));
    const { processor, recordEventConsumed } = build({ handlers: { 'order.expired': inTransaction(record) } });

    await expect(processor.process(job({ eventType: 'order.expired' }), 'orders')).rejects.toThrow('handler exploded');
    // A new id, because this fake keeps the claim a real rollback would release.
    const unknownEvent = job({ outboxId: sampleId(3), eventType: 'order.whatever' });
    await expect(processor.process(unknownEvent, 'orders')).rejects.toBeInstanceOf(UnhandledEventError);

    expect(recordEventConsumed.mock.calls).toEqual([
      ['order.expired', 'failed'],
      ['unregistered', 'failed'],
    ]);
  });

  it('rejects a malformed envelope before the claim, without echoing its payload', async () => {
    const { processor, claims } = build();

    const rejection = processor.process(job({ eventType: '', payload: { email: 'buyer@example.com' } }), 'orders');

    await expect(rejection).rejects.toThrow(/^Malformed domain event envelope/);
    await expect(rejection).rejects.not.toThrow('buyer@example.com');
    expect(claims.size).toBe(0);
  });

  // Two queues never share a consumer group, so one message id claimed on one says nothing on the other.
  it('claims under the consumer group of the queue the job came from', async () => {
    const { processor, claimed } = build();

    await expect(processor.process(job(), 'orders')).resolves.toBe('processed');
    await expect(processor.process(job(), 'catalog')).resolves.toBe('processed');
    await expect(processor.process(job(), 'catalog')).resolves.toBe('duplicate');

    expect(claimed.map(({ consumer }) => consumer)).toEqual(['orders', 'catalog-sync']);
  });

  it('refuses a job from a queue this process does not consume', async () => {
    const { processor, claims } = build();

    await expect(processor.process(job(), 'payments')).rejects.toThrow(/no consumer/);
    expect(claims.size).toBe(0);
  });
});
