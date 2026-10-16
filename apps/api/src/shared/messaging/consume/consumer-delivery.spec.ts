import { describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import { sampleId } from '@shared/testing/id-generator.double';
import { PermanentError, UnhandledEventError } from '../errors';
import type { DomainEventJob } from '../queue/domain-event.job';
import type { AppliedResult, DomainEventProcessor } from '../queue/domain-event.processor';
import { ConsumerRetryStore } from '../retry/consumer-retry.store';
import { dispatcherWith } from '../testing/domain-event-dispatcher.double';
import { loggedText } from '../testing/logged-text';
import { ConsumerDelivery } from './consumer-delivery';

const CONSUMER = 'domain-events';
const MESSAGE_ID = sampleId(1);
const LADDER = {
  'queue.consumerAttempts': 3,
  'queue.consumerBackoffMs': 100,
  'queue.orderPaidAttempts': 5,
  'queue.orderPaidBackoffCapMs': 1_000,
};

const job = (overrides: Partial<DomainEventJob> = {}): DomainEventJob => ({
  outboxId: MESSAGE_ID,
  aggregateType: 'Order',
  aggregateId: sampleId(2),
  eventType: 'order.placed',
  payload: { email: 'buyer@example.com' },
  occurredAt: '2026-10-01T00:00:00.000Z',
  traceparent: null,
  ...overrides,
});

interface BuildOptions {
  process?: (job: DomainEventJob, consumer: string) => Promise<AppliedResult>;
  store?: Partial<ConsumerRetryStore> | ConsumerRetryStore;
  ladder?: Record<string, number>;
}

function build({ process = () => Promise.resolve('processed'), store = {}, ladder = LADDER }: BuildOptions = {}) {
  const park = vi.fn().mockResolvedValue(true);
  const insertDead = vi.fn().mockResolvedValue(true);
  const metrics = fakeMetricsPort();
  const error = vi.fn();
  const warn = vi.fn();
  const delivery = new ConsumerDelivery(
    { process: vi.fn(process) } as unknown as DomainEventProcessor,
    store instanceof ConsumerRetryStore ? store : ({ park, insertDead, ...store } as unknown as ConsumerRetryStore),
    dispatcherWith(),
    metrics,
    fakeConfigService(ladder),
    fakePinoLogger({ error, warn }),
  );
  return { delivery, park, insertDead, metrics, error, warn };
}

const failingWith = (error: Error) => () => Promise.reject(error);

describe('ConsumerDelivery', () => {
  describe('deliver', () => {
    it('writes no row for a delivery that applied or was a duplicate', async () => {
      for (const result of ['processed', 'duplicate'] as const) {
        const t = build({ process: () => Promise.resolve(result) });

        await expect(t.delivery.deliver(CONSUMER, job())).resolves.toBe(result);
        expect(t.park).not.toHaveBeenCalled();
      }
    });

    it('parks a transient failure for its second attempt one backoff from now', async () => {
      const failure = new Error('connection reset');
      const t = build({ process: failingWith(failure) });

      await expect(t.delivery.deliver(CONSUMER, job())).resolves.toBe('retrying');

      expect(t.park).toHaveBeenCalledWith(CONSUMER, job(), failure, { status: 'pending', delayMs: 100 });
      expect(t.metrics.recordConsumeRetry).toHaveBeenCalledWith('order.placed');
      expect(t.metrics.recordDeadLetter).not.toHaveBeenCalled();
    });

    it('waits the long ladder first rung for an event that rides it', async () => {
      const t = build({ process: failingWith(new Error('user-service down')) });

      await t.delivery.deliver(CONSUMER, job({ eventType: 'order.paid' }));

      expect(t.park.mock.calls[0][3]).toEqual({ status: 'pending', delayMs: 100 });
    });

    it('dead-letters a permanent failure on its first delivery', async () => {
      for (const failure of [new PermanentError('no order id'), new UnhandledEventError('payment.refunded')]) {
        const t = build({ process: failingWith(failure) });
        const delivered = job({
          eventType: failure instanceof UnhandledEventError ? 'payment.refunded' : 'order.placed',
        });

        await expect(t.delivery.deliver(CONSUMER, delivered)).resolves.toBe('dead');

        expect(t.park).toHaveBeenCalledWith(CONSUMER, delivered, failure, { status: 'dead', reason: 'permanent' });
        expect(t.metrics.recordDeadLetter).toHaveBeenCalledWith(
          failure instanceof UnhandledEventError ? 'unregistered' : 'order.placed',
          'permanent',
        );
      }
    });

    it('dead-letters a routable envelope that is broken elsewhere as permanent', async () => {
      const t = build({
        process: failingWith(new PermanentError('Malformed domain event envelope (fields: outboxId)')),
      });

      await expect(t.delivery.deliver(CONSUMER, job({ eventType: '' }))).resolves.toBe('dead');

      expect(t.park.mock.calls[0][3]).toEqual({ status: 'dead', reason: 'permanent' });
    });

    it('dead-letters at once when the ladder allows a single attempt', async () => {
      const t = build({ process: failingWith(new Error('boom')), ladder: { ...LADDER, 'queue.consumerAttempts': 1 } });

      await expect(t.delivery.deliver(CONSUMER, job())).resolves.toBe('dead');

      expect(t.park.mock.calls[0][3]).toEqual({ status: 'dead', reason: 'attempts_exhausted' });
      expect(t.metrics.recordDeadLetter).toHaveBeenCalledWith('order.placed', 'attempts_exhausted');
    });

    it('counts nothing when the message already has a row, leaving its ladder running', async () => {
      const t = build({ process: failingWith(new Error('boom')), store: { park: vi.fn().mockResolvedValue(false) } });

      await expect(t.delivery.deliver(CONSUMER, job())).resolves.toBe('retrying');

      expect(t.metrics.recordConsumeRetry).not.toHaveBeenCalled();
      expect(t.metrics.recordDeadLetter).not.toHaveBeenCalled();
    });

    // The transport's own retry is the only net left while Postgres is down.
    it('logs and rethrows when the retry row cannot be written', async () => {
      const outage = Object.assign(new Error('connection terminated'), { code: '57P01' });
      const t = build({ process: failingWith(new Error('boom')), store: { park: vi.fn().mockRejectedValue(outage) } });

      await expect(t.delivery.deliver(CONSUMER, job())).rejects.toBe(outage);

      expect(t.error).toHaveBeenCalledOnce();
      expect(t.metrics.recordConsumeRetry).not.toHaveBeenCalled();
    });

    // A query wrapper's message lists the statement's parameters, and the park's parameters are the envelope.
    it('keeps the payload out of the logs and out of the error handed back to the transport', async () => {
      const handlerFailure = new Error('Failed query: select ...\nparams: buyer@example.com', {
        cause: new Error('deadlock detected'),
      });
      const outage = new Error(
        'Failed query: insert into "consumer_retries" ...\nparams: {"email":"buyer@example.com"}',
        {
          cause: Object.assign(new Error('connection terminated'), { code: '57P01' }),
        },
      );
      const t = build({ process: failingWith(handlerFailure), store: { park: vi.fn().mockRejectedValue(outage) } });

      const thrown = await t.delivery.deliver(CONSUMER, job()).catch((caught: unknown) => caught);

      expect(thrown).toBe(outage.cause);
      expect(loggedText(t.error, t.warn)).not.toContain('buyer@example.com');
    });

    // Redelivering a row Postgres refuses as data would refuse it again, forever.
    it('gives up on a row Postgres refuses as data instead of handing it back to the transport', async () => {
      const refused = new Error('Failed query: insert ...', {
        cause: Object.assign(new Error('unsupported Unicode escape sequence'), { code: '22P05' }),
      });
      const t = build({ process: failingWith(new Error('boom')), store: { park: vi.fn().mockRejectedValue(refused) } });

      await expect(t.delivery.deliver(CONSUMER, job())).resolves.toBe('dead');

      expect(t.metrics.recordDeadLetter).toHaveBeenCalledWith('order.placed', 'permanent');
      expect(t.error).toHaveBeenCalledOnce();
    });

    it('stores only the root cause of the failure, never the query that carried the payload', async () => {
      const values: Record<string, unknown>[] = [];
      const db = {
        insert: () => ({
          values: (row: Record<string, unknown>) => {
            values.push(row);
            return { onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ consumer: CONSUMER }]) }) };
          },
        }),
      } as unknown as DrizzleDB;
      const failure = new Error('Failed query: select $1\nparams: buyer@example.com', {
        cause: Object.assign(new Error('division by zero'), { name: 'error', code: '22012' }),
      });
      const t = build({ process: failingWith(failure), store: new ConsumerRetryStore(db) });

      await t.delivery.deliver(CONSUMER, job());

      expect(values[0]).toMatchObject({ status: 'pending', attemptsMade: 1, lastError: 'error: division by zero' });
      expect(JSON.stringify(values[0].lastError)).not.toContain('buyer@example.com');
    });

    it('drops an envelope it has no key for, counting it and logging field names only', async () => {
      const t = build({ process: failingWith(new PermanentError('Malformed domain event envelope')) });
      const unkeyed = {
        eventType: 'order.placed',
        payload: { email: 'buyer@example.com' },
      } as unknown as DomainEventJob;

      await expect(t.delivery.deliver(CONSUMER, unkeyed)).resolves.toBe('dead');

      expect(t.park).not.toHaveBeenCalled();
      expect(t.metrics.recordDeadLetter).toHaveBeenCalledWith('unregistered', 'permanent');
      expect(JSON.stringify(t.error.mock.calls)).not.toContain('buyer@example.com');
      expect(JSON.stringify(t.error.mock.calls)).toContain('eventType,payload');
    });
  });

  describe('recordTransportExhausted', () => {
    const exhausted = new Error('connect ECONNREFUSED 127.0.0.1:5432');

    it('logs, counts and files a dead row for a delivery the transport gave up on', async () => {
      const t = build();

      await t.delivery.recordTransportExhausted(CONSUMER, job(), 3, exhausted);

      expect(t.error).toHaveBeenCalledOnce();
      expect(t.metrics.recordDeadLetter).toHaveBeenCalledWith('order.placed', 'attempts_exhausted');
      expect(t.insertDead).toHaveBeenCalledWith(CONSUMER, job(), 3, exhausted);
    });

    it('keeps the log and the count when the dead row cannot be written either', async () => {
      const t = build({ store: { insertDead: vi.fn().mockRejectedValue(exhausted) } });

      await expect(t.delivery.recordTransportExhausted(CONSUMER, job(), 3, exhausted)).resolves.toBeUndefined();

      expect(t.metrics.recordDeadLetter).toHaveBeenCalledWith('order.placed', 'attempts_exhausted');
      expect(t.error).toHaveBeenCalledTimes(2);
    });

    it('logs the root cause, not the query wrapper that carried the payload', async () => {
      const t = build();
      const wrapped = new Error('Failed query: insert ...\nparams: {"email":"buyer@example.com"}', {
        cause: exhausted,
      });

      await t.delivery.recordTransportExhausted(CONSUMER, job(), 3, wrapped);

      expect(loggedText(t.error)).not.toContain('buyer@example.com');
      expect(loggedText(t.error)).toContain('ECONNREFUSED');
    });

    it('files no row for an envelope without a routable id', async () => {
      const t = build();

      await t.delivery.recordTransportExhausted(CONSUMER, undefined, 1, exhausted);

      expect(t.insertDead).not.toHaveBeenCalled();
      expect(t.metrics.recordDeadLetter).toHaveBeenCalledWith('unregistered', 'attempts_exhausted');
    });
  });
});
