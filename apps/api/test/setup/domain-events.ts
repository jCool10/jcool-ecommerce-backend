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

const RELAY_BATCH = 100;
const QUEUED_STATES = ['waiting', 'delayed', 'prioritized'] as const;

export interface DrainedEvent {
  eventType: string;
  outboxId: string;
  result: ConsumeResult;
}

/**
 * What the relay and the worker do unattended, run in the foreground: relay, then deliver every
 * queued job, until a pass finds nothing. A job leaves the queue only once it is applied, and the
 * first failure stops the drain, so a broken consume can never pass for a converged one.
 */
export async function drainDomainEvents(
  app: INestApplication,
  { maxPasses = 3 }: { maxPasses?: number } = {},
): Promise<DrainedEvent[]> {
  const relay = app.get(OutboxRelay);
  const processor = app.get(DomainEventProcessor);
  const queue = app.get<Queue<DomainEventJob>>(DOMAIN_EVENTS_QUEUE);
  const db = app.get<DrizzleDB>(DRIZZLE);
  const drained: DrainedEvent[] = [];

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const relayed = await relay.runOnce(RELAY_BATCH);
    if (relayed.failed > 0) throw new Error(`relay refused ${relayed.failed} outbox rows`);

    const jobs = await queue.getJobs([...QUEUED_STATES]);
    if (jobs.length === 0) {
      // The relay skips its tick while Redis is not ready, which looks exactly like an empty outbox.
      const [{ unpublished }] = await db
        .select({ unpublished: count() })
        .from(outbox)
        .where(isNull(outbox.publishedAt));
      if (unpublished > 0) throw new Error(`${unpublished} outbox rows were never relayed`);
      return drained;
    }

    for (const job of jobs) {
      const { eventType, outboxId } = job.data;
      const result = await processor.process(job.data).catch((error: unknown) => {
        throw new Error(`delivering ${eventType} ${outboxId} failed`, { cause: error });
      });
      if (result !== 'processed' && result !== 'duplicate') {
        throw new Error(`delivering ${eventType} ${outboxId} ended ${result}`);
      }
      await job.remove();
      drained.push({ eventType, outboxId, result });
    }
  }
  throw new Error(`domain events still queued after ${maxPasses} passes`);
}
