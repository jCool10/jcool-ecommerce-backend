import { Inject, Injectable } from '@nestjs/common';
import { context } from '@opentelemetry/api';
import type { Queue } from 'bullmq';
import { asc, eq, isNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { extractTraceContext, injectTraceContext } from '@shared/observability/tracing/propagation';
import { withSpan } from '@shared/observability/tracing/tracer';
import { EVENT_LABEL_REGISTRY, type EventLabelRegistry } from '../queue/domain-event-dispatcher.port';
import type { DomainEventJob } from '../queue/domain-event.job';
import { DOMAIN_EVENTS_QUEUE, QUEUE_CONNECTION } from '../queue/queue.constants';
import { outbox } from './schema/outbox.schema';

const LOG_CONTEXT = 'OutboxRelay';
const MAX_REFUSALS_PER_TICK = 3;

type OutboxRow = typeof outbox.$inferSelect;

export interface RelayTickSummary {
  published: number;
  failed: number;
}

/**
 * Poll, publish and mark published all happen in one transaction. A crash between the publish and
 * the commit leaves the row unpublished, so the next tick sends it again: at-least-once by
 * construction, and collapsing a redelivery back into one effect belongs to the consumer.
 */
@Injectable()
export class OutboxRelay {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(DOMAIN_EVENTS_QUEUE) private readonly queue: Queue,
    @Inject(QUEUE_CONNECTION) private readonly connection: Redis,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    // The label half of the dispatch table only: `label()` folds the free-text `outbox.event_type` into
    // the bounded set of names. The fold is also the signal: `event_type="unregistered"` climbing
    // here means events are heading straight for the DLQ, a full retry budget before it says so.
    @Inject(EVENT_LABEL_REGISTRY) private readonly eventLabels: EventLabelRegistry,
    private readonly logger: PinoLogger,
  ) {}

  async runOnce(batchSize: number): Promise<RelayTickSummary> {
    // Cheap short-circuit only: with no offline buffer every publish throws while Redis is away, so
    // there is no point opening a transaction to fail inside. What actually keeps an outage off the
    // rows' attempt budget is the batch check below.
    if (!this.isConnected()) return { published: 0, failed: 0 };

    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(outbox)
        .where(isNull(outbox.publishedAt))
        // The UUIDv7 id breaks `created_at` ties, which are routine.
        .orderBy(asc(outbox.createdAt), asc(outbox.id))
        .limit(batchSize)
        // Rows another instance holds are skipped, not waited on: multi-instance safety and
        // throughput without leader election, paid for in global ordering.
        .for('update', { skipLocked: true });

      const refused: OutboxRow[] = [];
      let lastError = '';
      let published = 0;

      for (const row of rows) {
        const eventType = this.eventLabels.label(row.eventType);
        try {
          await this.publish(row);
        } catch (error) {
          this.metrics.recordEventPublished(eventType, 'refused');
          refused.push(row);
          lastError = error instanceof Error ? error.message : String(error);
          // Several refusals in one tick is the queue failing, not that many bad rows. Stop rather
          // than pay its timeout again for every row left in the batch.
          if (refused.length >= MAX_REFUSALS_PER_TICK) break;
          continue;
        }
        // Counted at the publish, not after the commit: the job is on the queue from here on, and a
        // crash before the mark commits does not take it back. Counting after the commit would
        // under-report exactly the window the outbox exists to survive.
        this.metrics.recordEventPublished(eventType, 'published');
        await tx.update(outbox).set({ publishedAt: new Date() }).where(eq(outbox.id, row.id));
        published += 1;
      }

      if (refused.length > 0) {
        // Only charge an attempt once something else in this batch got through: that is the proof
        // the queue works and the row itself is what it rejected. Otherwise the queue is refusing
        // everything, and charging for that would let one outage dead-letter a healthy backlog.
        if (published > 0) {
          for (const row of refused) {
            await tx
              .update(outbox)
              .set({ attempts: row.attempts + 1 })
              .where(eq(outbox.id, row.id));
          }
        }
        // One line per tick, not one per row: an outage refuses the whole batch every time.
        this.logger.warn(
          { context: LOG_CONTEXT, refused: refused.length, charged: published > 0, outboxId: refused[0].id },
          `outbox publish refused: ${lastError}`,
        );
      }

      return { published, failed: refused.length };
    });
  }

  private isConnected(): boolean {
    return this.connection.status === 'ready';
  }

  private async publish(row: OutboxRow): Promise<void> {
    const parent = row.traceparent ? extractTraceContext({ traceparent: row.traceparent }) : context.active();

    await context.with(parent, () =>
      withSpan('outbox.publish', async () => {
        // Re-injected rather than forwarded so the consumer's spans hang off this publish; falls
        // back to the stored header when no SDK is registered.
        const { traceparent } = injectTraceContext();
        const job: DomainEventJob = {
          outboxId: row.id,
          aggregateType: row.aggregateType,
          aggregateId: row.aggregateId,
          eventType: row.eventType,
          payload: row.payload,
          occurredAt: row.createdAt.toISOString(),
          traceparent: traceparent ?? row.traceparent,
        };

        // Republishing a row BullMQ still remembers is a no-op instead of a second job — best effort
        // only, since a completed job eventually ages out of retention and frees the id again.
        await this.queue.add(row.eventType, job, { jobId: row.id });
      }),
    );
  }
}
