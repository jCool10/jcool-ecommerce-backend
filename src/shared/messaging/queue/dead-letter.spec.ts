import type { Job, Queue } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import type { MetricsPort } from '@shared/observability/metrics/metrics.port';
import { PermanentError, UnhandledEventError } from '../errors';
import { DomainEventDispatcher } from '../handlers/domain-event.dispatcher';
import type { PaymentEventsHandler } from '@modules/order/interface/queue/payment-events.handler';
import type { OrderExpiredHandler } from '@modules/payment/interface/queue/order-expired.handler';
import type { OrderEventsHandler } from '../handlers/order-events.handler';
import { DeadLetterRouter } from './dead-letter';
import type { DomainEventJob } from './domain-event.job';

const MESSAGE_ID = '0198f0d8-0000-7000-8000-000000000001';

const envelope = (overrides: Partial<DomainEventJob> = {}): DomainEventJob => ({
  outboxId: MESSAGE_ID,
  aggregateType: 'Order',
  aggregateId: '0198f0d8-1111-7000-8000-000000000001',
  eventType: 'order.placed',
  payload: { orderId: '0198f0d8-1111-7000-8000-000000000001' },
  occurredAt: '2026-08-24T00:00:00.000Z',
  traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
  ...overrides,
});

/**
 * `finishedOn` is what BullMQ sets on the branch where it decided NOT to retry — it is the whole
 * terminal/transient signal, so every case here differs only in that field and the error type.
 */
function build({
  finishedOn,
  data = envelope(),
  name = 'order.placed',
  attemptsMade = 5,
  addRejects = false,
}: {
  finishedOn?: number;
  data?: Partial<DomainEventJob>;
  name?: string;
  attemptsMade?: number;
  addRejects?: boolean;
} = {}) {
  const add = addRejects ? vi.fn().mockRejectedValue(new Error('redis gone')) : vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue(1);
  const recordConsumeRetry = vi.fn();
  const recordDeadLetter = vi.fn();
  const logError = vi.fn();
  // The real dispatcher, so the label assertions prove the router consults the actual dispatch table
  // rather than a stub that folds by the same rule the assertion expects.
  const dispatcher = new DomainEventDispatcher(
    { record: vi.fn() } as unknown as OrderEventsHandler,
    { settle: vi.fn() } as unknown as PaymentEventsHandler,
    { close: vi.fn() } as unknown as OrderExpiredHandler,
  );

  const router = new DeadLetterRouter(
    { add, remove } as unknown as Queue,
    { recordConsumeRetry, recordDeadLetter } as unknown as MetricsPort,
    dispatcher,
    { warn: vi.fn(), error: logError } as unknown as PinoLogger,
  );
  const job = { name, data, attemptsMade, finishedOn, id: 'bullmq-job-id' } as unknown as Job<DomainEventJob>;

  return { router, job, add, remove, recordConsumeRetry, recordDeadLetter, logError };
}

describe('DeadLetterRouter', () => {
  it('counts a retry and leaves the message alone while the queue still has attempts left', async () => {
    const { router, job, add, recordConsumeRetry, recordDeadLetter } = build({
      finishedOn: undefined,
      attemptsMade: 2,
    });

    await router.route(job, new Error('database unavailable'));

    expect(recordConsumeRetry).toHaveBeenCalledWith('order.placed');
    expect(add).not.toHaveBeenCalled();
    expect(recordDeadLetter).not.toHaveBeenCalled();
  });

  it('dead-letters a message whose retry budget ran out, keeping enough to reconcile it', async () => {
    const { router, job, add, recordDeadLetter } = build({ finishedOn: 1_700_000_000_000 });

    await router.route(job, new Error('database unavailable'));

    expect(add).toHaveBeenCalledWith(
      'order.placed',
      expect.objectContaining({
        outboxId: MESSAGE_ID,
        eventType: 'order.placed',
        payload: { orderId: '0198f0d8-1111-7000-8000-000000000001' },
        traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
        failedReason: 'database unavailable',
        attemptsMade: 5,
      }),
      // Keyed on the message: a second poisoning of the same event must not add a second copy.
      { jobId: MESSAGE_ID },
    );
    expect(recordDeadLetter).toHaveBeenCalledWith('order.placed', 'attempts_exhausted');
  });

  it('clears the previous entry first, so the slot holds the latest diagnosis rather than the first', async () => {
    const { router, job, add, remove } = build({ finishedOn: 1_700_000_000_000 });

    await router.route(job, new Error('second, different reason'));

    // Ordering is the whole point: `add` on an existing jobId is silently ignored, so a remove that
    // ran afterwards would leave the stale reason in place and delete nothing that mattered.
    expect(remove).toHaveBeenCalledWith(MESSAGE_ID);
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(add.mock.invocationCallOrder[0]);
  });

  it('separates a permanent failure from a spent budget, so the two can be alerted on differently', async () => {
    const { router, job, recordDeadLetter } = build({ finishedOn: 1_700_000_000_000, attemptsMade: 1 });

    await router.route(job, new UnhandledEventError('payment.succeeded'));

    expect(recordDeadLetter).toHaveBeenCalledWith('order.placed', 'permanent');
  });

  it('keeps an unregistered event type off the metric label', async () => {
    const { router, job, recordDeadLetter } = build({
      finishedOn: 1_700_000_000_000,
      name: 'attacker.controlled.name',
    });

    await router.route(job, new PermanentError('nope'));

    expect(recordDeadLetter).toHaveBeenCalledWith('unregistered', 'permanent');
  });

  it('falls back to the delivery id when the envelope was too broken to carry one', async () => {
    const { router, job, add } = build({ finishedOn: 1_700_000_000_000, data: {} });

    await router.route(job, new PermanentError('Malformed domain event envelope (fields: none)'));

    expect(add).toHaveBeenCalledWith(expect.anything(), expect.anything(), { jobId: 'bullmq-job-id' });
  });

  it('survives its own write failing — the main queue keeps the failed job either way', async () => {
    const { router, job, recordDeadLetter, logError } = build({ finishedOn: 1_700_000_000_000, addRejects: true });

    await expect(router.route(job, new Error('boom'))).resolves.toBeUndefined();

    // Not counted: claiming a dead letter that never landed would hide the one failure mode this
    // path cannot recover from on its own.
    expect(recordDeadLetter).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('redis gone'));
  });
});
