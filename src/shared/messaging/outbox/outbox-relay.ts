import { Inject, Injectable } from '@nestjs/common';
import { context } from '@opentelemetry/api';
import type { Queue } from 'bullmq';
import { asc, eq, isNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import { extractTraceContext, injectTraceContext } from '@shared/observability/tracing/propagation';
import { withSpan } from '@shared/observability/tracing/tracer';
import { DOMAIN_EVENTS_QUEUE, QUEUE_CONNECTION } from '../queue/queue.constants';
import { outbox } from './schema/outbox.schema';

const LOG_CONTEXT = 'OutboxRelay';
const MAX_REFUSALS_PER_TICK = 3;

type OutboxRow = typeof outbox.$inferSelect;

export interface DomainEventJob {
  /** Stable across redeliveries of the same event — the key a consumer dedups on. */
  outboxId: string;

  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  traceparent: string | null;
}

export interface RelayTickSummary {
  published: number;
  failed: number;
}

/**
 * Carries committed outbox rows to the queue: poll the unpublished ones, publish, mark published —
 * all in one transaction. A crash between the publish and the commit leaves the row unpublished, so
 * the next tick sends it again. At-least-once by construction; collapsing a redelivery back into a
 * single effect belongs to the consumer.
 */
@Injectable()
export class OutboxRelay {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(DOMAIN_EVENTS_QUEUE) private readonly queue: Queue,
    @Inject(QUEUE_CONNECTION) private readonly connection: Redis,
    private readonly logger: PinoLogger,
  ) {}

  async runOnce(batchSize: number): Promise<RelayTickSummary> {
    // Cheap short-circuit only: with no offline buffer every publish throws while Redis is away, so
    // there is no point opening a transaction to fail inside. What actually keeps an outage off the
    // rows' attempt budget is the batch check below, which also covers a Redis that is reachable but
    // refusing writes.
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
        try {
          await this.publish(row);
        } catch (error) {
          refused.push(row);
          lastError = error instanceof Error ? error.message : String(error);
          // Several refusals in one tick is the queue failing, not that many bad rows. Stop rather
          // than pay its timeout again for every row left in the batch.
          if (refused.length >= MAX_REFUSALS_PER_TICK) break;
          continue;
        }
        await tx.update(outbox).set({ publishedAt: new Date() }).where(eq(outbox.id, row.id));
        published += 1;
      }

      if (refused.length > 0) {
        // Only charge an attempt once something else in this batch got through: that is the proof
        // the queue works and the row itself is what it rejected. Otherwise the queue is refusing
        // everything — out of memory, a read-only replica, a reload — and charging for that would
        // let one outage dead-letter a healthy backlog the moment a retry budget reads the column.
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
        // Re-injected rather than forwarded so the consumer's spans hang off this publish. Falls back
        // to the stored header when no SDK is registered, which would otherwise drop the context.
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
