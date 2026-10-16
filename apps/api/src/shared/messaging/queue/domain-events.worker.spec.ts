import type { ClsService } from 'nestjs-cls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { ConsumerDelivery } from '../consume/consumer-delivery';
import type { DomainEventJob } from './domain-event.job';
import { DomainEventsWorker } from './domain-events.worker';
import { DOMAIN_EVENTS_CONSUMER } from './queue.constants';

interface FakeWorker {
  processor: (job: { name: string; data: DomainEventJob }) => Promise<unknown>;
  emit(event: string, ...args: unknown[]): boolean;
}

const created = vi.hoisted(() => ({ workers: [] as FakeWorker[] }));

vi.mock('bullmq', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Worker: class extends EventEmitter {
      constructor(
        _name: string,
        readonly processor: unknown,
      ) {
        super();
        created.workers.push(this as unknown as FakeWorker);
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
    },
  };
});

vi.mock('./queue-connection', () => ({
  createQueueConnection: () => ({ quit: () => Promise.resolve('OK'), disconnect: () => {} }),
}));

const CONFIG = {
  'queue.workerEnabled': true,
  'queue.workerConcurrency': 1,
  'queue.prefix': 'bull',
  'redis.url': 'redis://localhost:6379',
  'queue.consumerBackoffMs': 1_000,
  'queue.orderPaidBackoffCapMs': 300_000,
};

const ENVELOPE: DomainEventJob = {
  outboxId: '7300000000000000001',
  aggregateType: 'order',
  aggregateId: '7300000000000000002',
  eventType: 'order.placed',
  payload: {},
  occurredAt: '2026-10-16T00:00:00.000Z',
  traceparent: null,
};

function start(delivery: Partial<ConsumerDelivery>) {
  const error = vi.fn();
  const worker = new DomainEventsWorker(
    delivery as ConsumerDelivery,
    fakeConfigService(CONFIG),
    { run: (fn: () => unknown) => fn(), set: vi.fn() } as unknown as ClsService,
    fakePinoLogger({ error }),
  );
  worker.onModuleInit();
  return { worker, bull: created.workers.at(-1)!, error };
}

describe('DomainEventsWorker', () => {
  afterEach(() => {
    created.workers.length = 0;
  });

  it('hands every delivery to the consumer delivery as the domain-events consumer', async () => {
    const deliver = vi.fn().mockResolvedValue('retrying');
    const { bull } = start({ deliver });

    await expect(bull.processor({ name: ENVELOPE.eventType, data: ENVELOPE })).resolves.toBe('retrying');
    expect(deliver).toHaveBeenCalledWith(DOMAIN_EVENTS_CONSUMER, ENVELOPE);
  });

  // `finishedOn` is set only once BullMQ schedules nothing more, which also covers a job that stalled
  // past maxStalledCount with attempts still left on its budget.
  it('files a dead letter once the transport gives up, a stalled job included', () => {
    const recordTransportExhausted = vi.fn().mockResolvedValue(undefined);
    const { bull } = start({ recordTransportExhausted });
    const failure = new Error('job stalled more than allowable limit');

    bull.emit('failed', { data: ENVELOPE, attemptsMade: 1, opts: { attempts: 8 }, finishedOn: Date.now() }, failure);

    expect(recordTransportExhausted).toHaveBeenCalledWith(DOMAIN_EVENTS_CONSUMER, ENVELOPE, 1, failure);
  });

  it('leaves a failure the transport will retry, or could not load, to the transport', () => {
    const recordTransportExhausted = vi.fn();
    const { bull, error } = start({ recordTransportExhausted });

    bull.emit('failed', { data: ENVELOPE, attemptsMade: 1, opts: { attempts: 8 } }, new Error('pg down'));
    bull.emit('failed', undefined, new Error('missing job'));

    expect(recordTransportExhausted).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });

  it('waits for a dead letter still being filed before shutting down', async () => {
    let filed: () => void = () => {};
    const recordTransportExhausted = vi.fn(() => new Promise<void>((resolve) => (filed = resolve)));
    const { worker, bull } = start({ recordTransportExhausted });
    bull.emit('failed', { data: ENVELOPE, attemptsMade: 8, finishedOn: Date.now() }, new Error('pg down'));

    let closed = false;
    const shutdown = worker.beforeApplicationShutdown().then(() => (closed = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);

    filed();
    await shutdown;
    expect(closed).toBe(true);
  });
});
