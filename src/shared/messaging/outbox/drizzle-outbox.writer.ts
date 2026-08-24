import { Injectable } from '@nestjs/common';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { injectTraceContext } from '@shared/observability/tracing/propagation';
import type { OutboxRecord, OutboxWriterPort } from './outbox-writer.port';
import { outbox } from './schema/outbox.schema';

/**
 * Drizzle adapter for OutboxWriterPort. Writes through the transaction handle it is GIVEN and
 * never opens one of its own — an append that started its own transaction would commit
 * independently of the business change and reintroduce the dual-write it exists to prevent.
 *
 * The traceparent is captured here rather than by the caller: the insert runs inside the
 * producer's active span, and the application layer is barred from importing telemetry (ADR 0015).
 */
@Injectable()
export class DrizzleOutboxWriter implements OutboxWriterPort {
  async append(tx: DrizzleTx, record: OutboxRecord): Promise<void> {
    const { traceparent } = injectTraceContext();
    await tx.insert(outbox).values({
      aggregateType: record.aggregateType,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      payload: record.payload,
      traceparent: traceparent ?? null,
    });
  }
}
