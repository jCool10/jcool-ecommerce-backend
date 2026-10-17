import { Inject, Injectable } from '@nestjs/common';
import { context, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { asc, eq, isNull } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { extractTraceContext, injectTraceContext } from '@jcool/platform/observability';
import { DomainEventDispatcher } from '../handlers/domain-event.dispatcher';
import {
  DOMAIN_EVENT_PUBLISHER,
  type DomainEventPublisher,
  type OutboundEvent,
  type PublishOutcome,
} from '../transport/domain-event-publisher.port';
import { outbox } from './schema/outbox.schema';

const LOG_CONTEXT = 'OutboxRelay';
// Same tracer name as `withSpan`, which cannot hold a span open across one batched call per row.
const TRACER_NAME = 'jcool';

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
    @Inject(DOMAIN_EVENT_PUBLISHER) private readonly publisher: DomainEventPublisher,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    // Not to dispatch anything — for `label()`, which folds the free-text `outbox.event_type` into
    // the bounded set of names. The fold is also the signal: `event_type="unregistered"` climbing
    // here means events are heading straight for the dead letters.
    private readonly domainEventDispatcher: DomainEventDispatcher,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async runOnce(batchSize: number): Promise<RelayTickSummary> {
    // Cheap short-circuit only: a broker that is away refuses every publish, so there is no point
    // opening a transaction to fail inside. What keeps an outage off the rows' attempt budget is the
    // charging rule below.
    if (!this.publisher.ready()) return { published: 0, failed: 0 };

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
      if (rows.length === 0) return { published: 0, failed: 0 };

      const outcomes = await this.publish(rows);

      const refused: OutboxRow[] = [];
      let lastError: Error | undefined;
      let published = 0;

      for (const [index, row] of rows.entries()) {
        const outcome = outcomes[index];
        if (outcome.skipped) continue;
        const eventType = this.domainEventDispatcher.label(row.eventType);
        if (!outcome.ok) {
          this.metrics.recordEventPublished(eventType, 'refused');
          refused.push(row);
          lastError = outcome.error ?? lastError;
          continue;
        }
        // Counted at the publish, not after the commit: the message is out from here on, and a crash
        // before the mark commits does not take it back. Counting after the commit would under-report
        // exactly the window the outbox exists to survive.
        this.metrics.recordEventPublished(eventType, 'published');
        await tx.update(outbox).set({ publishedAt: new Date() }).where(eq(outbox.id, row.id));
        published += 1;
      }

      if (refused.length > 0) {
        // Only charge an attempt once something else in this batch got through: that is the proof
        // the broker works and the row itself is what it rejected. Otherwise the broker is refusing
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
          { refused: refused.length, charged: published > 0, outboxId: refused[0].id, err: lastError },
          'outbox publish refused',
        );
      }

      return { published, failed: refused.length };
    });
  }

  // One `outbox.publish` span per row, held open across the batch so each covers its own send.
  private async publish(rows: OutboxRow[]): Promise<PublishOutcome[]> {
    const tracer = trace.getTracer(TRACER_NAME);
    const spans: Span[] = [];
    const events = rows.map((row): OutboundEvent => {
      const parent = row.traceparent ? extractTraceContext({ traceparent: row.traceparent }) : context.active();
      const span = tracer.startSpan('outbox.publish', undefined, parent);
      spans.push(span);
      // Re-injected rather than forwarded so the consumer's spans hang off this publish; falls back
      // to the stored header when no SDK is registered.
      const { traceparent } = context.with(trace.setSpan(parent, span), () => injectTraceContext());
      return {
        rowId: row.id,
        eventType: row.eventType,
        aggregateId: row.aggregateId,
        envelope: {
          outboxId: row.id,
          aggregateType: row.aggregateType,
          aggregateId: row.aggregateId,
          eventType: row.eventType,
          payload: row.payload,
          occurredAt: row.createdAt.toISOString(),
          traceparent: traceparent ?? row.traceparent,
        },
      };
    });

    let outcomes: PublishOutcome[] | undefined;
    try {
      outcomes = await this.publisher.publish(events);
      return outcomes;
    } finally {
      for (const [index, span] of spans.entries()) {
        const outcome = outcomes?.[index];
        if (!outcome?.ok) {
          if (outcome?.error) span.recordException(outcome.error);
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        span.end();
      }
    }
  }
}
