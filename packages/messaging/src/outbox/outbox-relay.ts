import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { context } from '@opentelemetry/api';
import type { Queue } from 'bullmq';
import { asc, eq, isNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { DRIZZLE } from '@jcool/platform/database';
import { extractTraceContext, injectTraceContext, withSpan } from '@jcool/platform/observability';
import type { MessagingDb } from '../messaging.database';
import type { MessagingModuleOptions } from '../messaging.options';
import { MESSAGING_OPTIONS, MESSAGING_QUEUES, QUEUE_CONNECTION } from '../messaging.tokens';
import { type DomainEventJob, jobIdFor } from '../queue/domain-event.job';
import { type QueueSpec, UNREGISTERED_EVENT_LABEL } from '../queue/queue-definition';
import { routeOf } from '../routing/event-routes';
import { outbox } from './schema/outbox.schema';

const LOG_CONTEXT = 'OutboxRelay';
const MAX_REFUSALS_PER_TICK = 3;

type OutboxRow = typeof outbox.$inferSelect;
type OutboxTxOf = Parameters<Parameters<MessagingDb['transaction']>[0]>[0];

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
  private readonly orderPaidAttempts: number;

  constructor(
    @Inject(DRIZZLE) private readonly db: MessagingDb,
    @Inject(MESSAGING_QUEUES) private readonly queues: ReadonlyMap<string, Queue>,
    @Inject(QUEUE_CONNECTION) private readonly queueConnection: Redis,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    // The route table is also the bounded set of metric labels: `event_type="unregistered"` climbing
    // here means rows were written for an event this build no longer routes.
    @Inject(MESSAGING_OPTIONS) private readonly options: Pick<MessagingModuleOptions, 'routes'>,
    config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.orderPaidAttempts = config.getOrThrow<number>('queue.orderPaidAttempts');
    logger.setContext(LOG_CONTEXT);
  }

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
        // The id breaks `created_at` ties, which are routine.
        .orderBy(asc(outbox.createdAt), asc(outbox.id))
        .limit(batchSize)
        // Rows another instance holds are skipped, not waited on: multi-instance safety and
        // throughput without leader election, paid for in global ordering.
        .for('update', { skipLocked: true });

      const refused: OutboxRow[] = [];
      const unrouted: OutboxRow[] = [];
      let lastError: Error | undefined;
      let published = 0;

      for (const row of rows) {
        const route = routeOf(this.options.routes, row.eventType);
        if (!route) {
          // Not the queue's fault, so it neither counts toward the refusals that end the tick nor
          // waits for proof that the queue works before it is charged.
          this.metrics.recordEventPublished(UNREGISTERED_EVENT_LABEL, 'refused');
          unrouted.push(row);
          continue;
        }
        try {
          await this.publish(row, route);
        } catch (error) {
          this.metrics.recordEventPublished(row.eventType, 'refused');
          refused.push(row);
          lastError = toError(error);
          // Several refusals in one tick is the queue failing, not that many bad rows. Stop rather
          // than pay its timeout again for every row left in the batch.
          if (refused.length >= MAX_REFUSALS_PER_TICK) break;
          continue;
        }
        // Counted at the publish, not after the commit: the job is on the queue from here on, and a
        // crash before the mark commits does not take it back. Counting after the commit would
        // under-report exactly the window the outbox exists to survive.
        this.metrics.recordEventPublished(row.eventType, 'published');
        await tx.update(outbox).set({ publishedAt: new Date() }).where(eq(outbox.id, row.id));
        published += 1;
      }

      if (unrouted.length > 0) {
        await this.charge(tx, unrouted);
        this.logger.error(
          { unrouted: unrouted.length, eventType: unrouted[0].eventType, outboxId: unrouted[0].id },
          'outbox rows have no route and stay unpublished',
        );
      }

      if (refused.length > 0) {
        // Only charge an attempt once something else in this batch got through: that is the proof
        // the queue works and the row itself is what it rejected. Otherwise the queue is refusing
        // everything, and charging for that would let one outage dead-letter a healthy backlog.
        if (published > 0) await this.charge(tx, refused);
        // One line per tick, not one per row: an outage refuses the whole batch every time.
        this.logger.warn(
          { refused: refused.length, charged: published > 0, outboxId: refused[0].id, err: lastError },
          'outbox publish refused',
        );
      }

      return { published, failed: refused.length + unrouted.length };
    });
  }

  private isConnected(): boolean {
    return this.queueConnection.status === 'ready';
  }

  private async charge(tx: OutboxTxOf, rows: OutboxRow[]): Promise<void> {
    for (const row of rows) {
      await tx
        .update(outbox)
        .set({ attempts: row.attempts + 1 })
        .where(eq(outbox.id, row.id));
    }
  }

  private async publish(row: OutboxRow, route: QueueSpec): Promise<void> {
    const queue = this.queues.get(route.name);
    if (!queue) throw new Error(`queue ${route.name} is routed but was never opened`);

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
        await queue.add(row.eventType, job, {
          jobId: jobIdFor(row.id),
          ...route.jobOptionsFor(row.eventType, this.orderPaidAttempts),
        });
      }),
    );
  }
}
