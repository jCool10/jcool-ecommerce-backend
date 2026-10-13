import type { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { count, isNull } from 'drizzle-orm';
import type { ConsumeResult } from '@jcool/metrics-port';
import { DRIZZLE, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { outbox } from '../../src/shared/infrastructure/database/schema';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';
import { DomainEventProcessor } from '../../src/shared/messaging/queue/domain-event.processor';
import { DOMAIN_EVENTS_QUEUE } from '../../src/shared/messaging/queue/queue.constants';
import { waitForSagaClosed } from './checkout-sagas';

const RELAY_BATCH = 100;
const QUEUED_STATES = ['waiting', 'delayed', 'prioritized'] as const;

export interface DrainedEvent {
  eventType: string;
  outboxId: string;
  result: ConsumeResult;
  /** Set for `payment.authorized`: the order whose saga the delivery signalled. */
  orderId?: string;
}

export interface DrainOptions {
  maxPasses?: number;
  /** Off for a test that parks a saga mid-flight on purpose. */
  awaitSagas?: boolean;
}

/**
 * What the relay and the worker do unattended, run in the foreground: relay, then deliver every
 * queued job, until a pass finds nothing. A job leaves the queue only once it is applied, and the
 * first failure stops the drain, so a broken consume can never pass for a converged one. Each pass
 * also waits for the sagas its authorizations signalled to close, so what they emit is relayed next pass.
 */
export async function drainDomainEvents(
  app: INestApplication,
  { maxPasses = 3, awaitSagas = true }: DrainOptions = {},
): Promise<DrainedEvent[]> {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const drained: DrainedEvent[] = [];

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const delivered = await deliverDomainEventsOnce(app);
    if (delivered.length === 0) {
      // The relay skips its tick while Redis is not ready, which looks exactly like an empty outbox.
      const [{ unpublished }] = await db
        .select({ unpublished: count() })
        .from(outbox)
        .where(isNull(outbox.publishedAt));
      if (unpublished > 0) throw new Error(`${unpublished} outbox rows were never relayed`);
      return drained;
    }
    drained.push(...delivered);
    if (awaitSagas) await waitForSignalledSagas(app, delivered);
  }
  throw new Error(`domain events still queued after ${maxPasses} passes`);
}

/** One relay-and-deliver pass; the sagas it signals keep running in the worker. */
export async function deliverDomainEventsOnce(app: INestApplication): Promise<DrainedEvent[]> {
  const relayed = await app.get(OutboxRelay).runOnce(RELAY_BATCH);
  if (relayed.failed > 0) throw new Error(`relay refused ${relayed.failed} outbox rows`);

  const processor = app.get(DomainEventProcessor);
  const queue = app.get<Queue<DomainEventJob>>(DOMAIN_EVENTS_QUEUE);
  const delivered: DrainedEvent[] = [];
  for (const job of await queue.getJobs([...QUEUED_STATES])) {
    const { eventType, outboxId, payload } = job.data;
    const result = await processor.process(job.data).catch((error: unknown) => {
      throw new Error(`delivering ${eventType} ${outboxId} failed`, { cause: error });
    });
    if (result !== 'processed' && result !== 'duplicate') {
      throw new Error(`delivering ${eventType} ${outboxId} ended ${result}`);
    }
    await job.remove();
    const orderId = eventType === 'payment.authorized' ? String(payload.orderId) : undefined;
    delivered.push({ eventType, outboxId, result, ...(orderId && { orderId }) });
  }
  return delivered;
}

async function waitForSignalledSagas(app: INestApplication, delivered: DrainedEvent[]): Promise<void> {
  const orderIds = new Set(delivered.flatMap(({ orderId }) => (orderId ? [orderId] : [])));
  await Promise.all([...orderIds].map((orderId) => waitForSagaClosed(app, orderId)));
}
