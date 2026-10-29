import type { INestApplication } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { ORDER_EVENTS_QUEUE } from '@jcool/internal-contracts/queues/order-events';
import { type DomainEventJob, OutboxRelay, QUEUE_CONNECTION, queueToken } from '@jcool/messaging';
import { waitForRedisReady } from './redis-ready';

const RELAY_BATCH = 100;
const QUEUED_STATES = ['waiting', 'delayed', 'prioritized'] as const;

/** The api's queue in this worker's Redis: nothing here consumes it, so whatever is relayed stays. */
export function orderEventsQueue(app: INestApplication): Queue<DomainEventJob> {
  return app.get<Queue<DomainEventJob>>(queueToken(ORDER_EVENTS_QUEUE));
}

export function queuedOrderEvents(app: INestApplication): Promise<Job<DomainEventJob>[]> {
  return orderEventsQueue(app).getJobs([...QUEUED_STATES]);
}

/** One relay tick in the foreground, then what sits on order-events. */
export async function relayOutbox(app: INestApplication): Promise<Job<DomainEventJob>[]> {
  // The relay skips a tick while its connection is not ready, which reads exactly like an empty outbox.
  await waitForRedisReady(app.get<Redis>(QUEUE_CONNECTION));
  const relayed = await app.get(OutboxRelay).runOnce(RELAY_BATCH);
  if (relayed.failed > 0) throw new Error(`relay refused ${relayed.failed} outbox rows`);
  return queuedOrderEvents(app);
}
