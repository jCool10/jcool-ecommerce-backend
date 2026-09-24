import type { Job, Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { MetricsPort } from '@jcool/metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { UnhandledEventError } from '../errors';
import { dispatcherWith } from '../testing/domain-event-dispatcher.double';
import { DeadLetterRouter, type DeadLetterJob } from './dead-letter';
import type { DomainEventJob } from './domain-event.job';

const MESSAGE_ID = '0198f0d8-0000-7000-8000-000000000001';
const FINISHED = 1_700_000_000_000;

const envelope: DomainEventJob = {
  outboxId: MESSAGE_ID,
  aggregateType: 'Order',
  aggregateId: '0198f0d8-1111-7000-8000-000000000001',
  eventType: 'order.placed',
  payload: { orderId: '0198f0d8-1111-7000-8000-000000000001' },
  occurredAt: '2026-08-24T00:00:00.000Z',
  traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
};

// Like BullMQ, `add` under a job id the queue already holds is silently ignored.
function inMemoryDlq({ addRejects = false } = {}) {
  const stored = new Map<string, DeadLetterJob>();
  const queue = {
    add: (_name: string, data: DeadLetterJob, { jobId }: { jobId: string }) => {
      if (addRejects) return Promise.reject(new Error('redis gone'));
      if (!stored.has(jobId)) stored.set(jobId, data);
      return Promise.resolve();
    },
    remove: (jobId: string) => Promise.resolve(stored.delete(jobId) ? 1 : 0),
  } as unknown as Queue;
  return { queue, stored };
}

function build(dlq = inMemoryDlq()) {
  const recordDeadLetter = vi.fn();
  const error = vi.fn();
  const router = new DeadLetterRouter(
    dlq.queue,
    { recordConsumeRetry: vi.fn(), recordDeadLetter } as unknown as MetricsPort,
    dispatcherWith(),
    fakePinoLogger({ error }),
  );
  return { router, stored: dlq.stored, recordDeadLetter, error };
}

const finishedJob = (overrides: { name?: string; data?: Partial<DomainEventJob> } = {}) =>
  ({
    name: 'order.placed',
    data: envelope,
    attemptsMade: 5,
    finishedOn: FINISHED,
    id: 'bullmq-job-id',
    ...overrides,
  }) as unknown as Job<DomainEventJob>;

describe('DeadLetterRouter', () => {
  it('labels the reason and folds an unregistered event type', async () => {
    const { router, recordDeadLetter } = build();

    await router.route(finishedJob(), new UnhandledEventError('payment.succeeded'));
    await router.route(finishedJob({ name: 'attacker.controlled.name' }), new Error('database unavailable'));

    expect(recordDeadLetter.mock.calls).toEqual([
      ['order.placed', 'permanent'],
      ['unregistered', 'attempts_exhausted'],
    ]);
  });

  it('keeps the latest diagnosis when a message is dead-lettered again', async () => {
    const { router, stored } = build();

    await router.route(finishedJob(), new Error('first reason'));
    await router.route(finishedJob(), new Error('second, different reason'));

    expect([...stored.keys()]).toEqual([MESSAGE_ID]);
    expect(stored.get(MESSAGE_ID)?.failedReason).toBe('second, different reason');
  });

  it('falls back to the delivery id when the envelope carries none', async () => {
    const { router, stored } = build();

    await router.route(finishedJob({ data: {} }), new Error('Malformed domain event envelope (fields: none)'));

    expect([...stored.keys()]).toEqual(['bullmq-job-id']);
  });

  // The main queue keeps the failed job either way; counting a dead letter that never landed would
  // hide the one failure this path cannot recover from.
  it('survives its own write failing without counting a dead letter', async () => {
    const { router, recordDeadLetter, error } = build(inMemoryDlq({ addRejects: true }));

    await expect(router.route(finishedJob(), new Error('boom'))).resolves.toBeUndefined();

    expect(recordDeadLetter).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });
});
