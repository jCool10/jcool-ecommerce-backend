import type { JobsOptions, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { toError } from '@jcool/kernel';
import type { DomainEventPublisher, OutboundEvent, PublishOutcome } from '../transport/domain-event-publisher.port';
import { CATALOG_EVENT_PRIORITY } from './queue.constants';

// Adds run one after another and each can wait out the 5s command timeout, all while the relay holds
// the batch's row locks. Three refusals in one batch is Redis failing, not three bad rows.
const MAX_REFUSALS_PER_BATCH = 3;

export class BullmqDomainEventPublisher implements DomainEventPublisher {
  constructor(
    private readonly queue: Queue,
    private readonly connection: Redis,
  ) {}

  ready(): boolean {
    return this.connection.status === 'ready';
  }

  async publish(events: OutboundEvent[]): Promise<PublishOutcome[]> {
    const outcomes: PublishOutcome[] = [];
    let refusals = 0;
    let lastRefusal: Error | undefined;

    for (const { rowId, eventType, envelope } of events) {
      if (refusals >= MAX_REFUSALS_PER_BATCH) {
        outcomes.push({ rowId, ok: false, error: lastRefusal, skipped: true });
        continue;
      }
      try {
        // No job id: a republish must be a real redelivery, and the inbox swallows the copies.
        await this.queue.add(eventType, envelope, catalogPriority(eventType));
        outcomes.push({ rowId, ok: true });
      } catch (error) {
        refusals += 1;
        lastRefusal = toError(error);
        outcomes.push({ rowId, ok: false, error: lastRefusal });
      }
    }
    return outcomes;
  }
}

function catalogPriority(eventType: string): JobsOptions | undefined {
  return eventType.startsWith('catalog.') ? { priority: CATALOG_EVENT_PRIORITY } : undefined;
}
