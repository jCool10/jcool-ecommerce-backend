import type { ClsService } from 'nestjs-cls';
import { describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { sampleId } from '@shared/testing/id-generator.double';
import { PermanentError } from '../errors';
import type { DomainEventJob } from '../queue/domain-event.job';
import type { DomainEventProcessor } from '../queue/domain-event.processor';
import { dispatcherWith } from '../testing/domain-event-dispatcher.double';
import { loggedText } from '../testing/logged-text';
import type { ConsumerRetryStore, LeasedRetry } from './consumer-retry.store';
import { RetryPoller } from './retry-poller';

const CONSUMER = 'domain-events';
const ATTEMPTS = 3;
const BACKOFF_MS = 100;
const LEASE_MS = 60_000;

let nextId = 10;
function leased(overrides: Partial<LeasedRetry> = {}): LeasedRetry {
  const messageId = sampleId(nextId++);
  const envelope: DomainEventJob = {
    outboxId: messageId,
    aggregateType: 'Order',
    aggregateId: sampleId(1),
    eventType: 'order.placed',
    payload: {},
    occurredAt: '2026-10-01T00:00:00.000Z',
    traceparent: null,
  };
  return {
    consumer: CONSUMER,
    messageId,
    eventType: 'order.placed',
    envelope,
    attemptsMade: 2,
    nextAttemptAt: new Date(),
    leaseToken: `lease-${messageId}`,
    status: 'pending',
    deadReason: null,
    lastError: 'Error: earlier',
    firstFailedAt: new Date(),
    lastFailedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

function build(rows: LeasedRetry[], process: (job: DomainEventJob) => Promise<unknown> = () => Promise.resolve()) {
  const trace: string[] = [];
  const due = [...rows];
  const store = {
    leaseOne: vi.fn((leaseMs: number) => {
      const row = due.shift();
      trace.push(`lease ${leaseMs} ${row?.messageId ?? 'none'}`);
      return Promise.resolve(row);
    }),
    complete: vi.fn((row: LeasedRetry) => {
      trace.push(`complete ${row.messageId}`);
      return Promise.resolve(true);
    }),
    reschedule: vi.fn().mockResolvedValue(true),
    bury: vi.fn().mockResolvedValue(true),
  };
  const handler = vi.fn((job: DomainEventJob) => {
    trace.push(`process ${job.outboxId}`);
    return process(job);
  });
  const metrics = fakeMetricsPort();
  const warn = vi.fn();
  const error = vi.fn();
  const poller = new RetryPoller(
    store as unknown as ConsumerRetryStore,
    { process: handler } as unknown as DomainEventProcessor,
    dispatcherWith(),
    metrics,
    { run: (fn: () => unknown) => fn(), set: vi.fn() } as unknown as ClsService,
    fakeConfigService({
      'queue.consumerAttempts': ATTEMPTS,
      'queue.consumerBackoffMs': BACKOFF_MS,
      'queue.orderPaidAttempts': 5,
      'queue.orderPaidBackoffCapMs': 1_000,
      'messaging.retry.leaseMs': LEASE_MS,
    }),
    fakePinoLogger({ warn, error }),
  );
  return { poller, store, handler, metrics, trace, warn, error };
}

describe('RetryPoller', () => {
  it('deletes the row once the retry applies', async () => {
    const row = leased();
    const t = build([row]);

    await expect(t.poller.runOnce(10)).resolves.toEqual({
      leased: 1,
      processed: 1,
      rescheduled: 0,
      buried: 0,
      lost: 0,
    });

    expect(t.handler).toHaveBeenCalledWith(row.envelope, CONSUMER);
    expect(t.store.complete).toHaveBeenCalledWith(row);
  });

  // The lease already charged this attempt, so the reschedule only sets the next rung.
  it('reschedules a failure with attempts left one rung further along', async () => {
    const failure = new Error('connection reset');
    const row = leased({ attemptsMade: 2 });
    const t = build([row], () => Promise.reject(failure));

    const summary = await t.poller.runOnce(10);

    expect(summary.rescheduled).toBe(1);
    expect(t.store.reschedule).toHaveBeenCalledWith(row, BACKOFF_MS * 2, failure);
    expect(t.metrics.recordConsumeRetry).toHaveBeenCalledWith('order.placed');
  });

  it('buries the row once its last attempt fails', async () => {
    const failure = new Error('still down');
    const row = leased({ attemptsMade: ATTEMPTS });
    const t = build([row], () => Promise.reject(failure));

    expect((await t.poller.runOnce(10)).buried).toBe(1);

    expect(t.store.bury).toHaveBeenCalledWith(row, 'attempts_exhausted', failure);
    expect(t.metrics.recordDeadLetter).toHaveBeenCalledWith('order.placed', 'attempts_exhausted');
  });

  it('logs the root cause of a failed retry, never the query wrapper that carried the payload', async () => {
    const failure = new Error('Failed query: update ...\nparams: buyer@example.com', {
      cause: new Error('deadlock detected'),
    });
    const t = build([leased({ attemptsMade: 2 }), leased({ attemptsMade: ATTEMPTS })], () => Promise.reject(failure));

    await t.poller.runOnce(10);

    expect(t.warn).toHaveBeenCalledOnce();
    expect(t.error).toHaveBeenCalledOnce();
    expect(loggedText(t.warn, t.error)).toContain('deadlock detected');
    expect(loggedText(t.warn, t.error)).not.toContain('buyer@example.com');
  });

  it('buries a permanent failure without spending the rest of the ladder', async () => {
    const failure = new PermanentError('payload has no order id');
    const row = leased({ attemptsMade: 2 });
    const t = build([row], () => Promise.reject(failure));

    await t.poller.runOnce(10);

    expect(t.store.bury).toHaveBeenCalledWith(row, 'permanent', failure);
    expect(t.metrics.recordDeadLetter).toHaveBeenCalledWith('order.placed', 'permanent');
  });

  // A message that crashes the process would otherwise be retried after every restart, forever.
  it('buries a row leased past its last attempt without running the handler again', async () => {
    const row = leased({ attemptsMade: ATTEMPTS + 1 });
    const t = build([row]);

    expect((await t.poller.runOnce(10)).buried).toBe(1);

    expect(t.handler).not.toHaveBeenCalled();
    expect(t.store.bury).toHaveBeenCalledWith(row, 'attempts_exhausted', undefined);
  });

  it('leases one row at a time and stops at the batch size', async () => {
    const [a, b, c] = [leased(), leased(), leased()];
    const t = build([a, b, c]);

    expect((await t.poller.runOnce(2)).leased).toBe(2);

    expect(t.trace).toEqual([
      `lease ${LEASE_MS} ${a.messageId}`,
      `process ${a.messageId}`,
      `complete ${a.messageId}`,
      `lease ${LEASE_MS} ${b.messageId}`,
      `process ${b.messageId}`,
      `complete ${b.messageId}`,
    ]);
  });

  it('stops early once nothing more is due', async () => {
    const t = build([leased()]);

    expect((await t.poller.runOnce(50)).leased).toBe(1);
    expect(t.store.leaseOne).toHaveBeenCalledTimes(2);
  });

  it('counts a lease another poller took over, without throwing or counting a metric', async () => {
    const t = build([leased({ attemptsMade: 2 })], () => Promise.reject(new Error('boom')));
    t.store.reschedule.mockResolvedValue(false);

    await expect(t.poller.runOnce(10)).resolves.toMatchObject({ rescheduled: 0, lost: 1 });

    expect(t.metrics.recordConsumeRetry).not.toHaveBeenCalled();
  });

  it('keeps working the batch after a handler throws', async () => {
    const [bad, good] = [leased(), leased()];
    const t = build([bad, good], (job) =>
      job.outboxId === bad.messageId ? Promise.reject(new Error('poison')) : Promise.resolve(),
    );

    await expect(t.poller.runOnce(10)).resolves.toMatchObject({ leased: 2, processed: 1, rescheduled: 1 });
  });

  it('stops leasing once shutdown aborts the tick', async () => {
    const controller = new AbortController();
    const t = build([leased(), leased()], () => {
      controller.abort();
      return Promise.resolve();
    });

    await expect(t.poller.runOnce(10, controller.signal)).resolves.toMatchObject({ leased: 1, processed: 1 });
  });
});
