import { Injectable } from '@nestjs/common';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { injectTraceContext } from '@shared/observability/tracing/propagation';
import type { OutboxRecord, OutboxWriterPort } from './outbox-writer.port';
import { outbox } from './schema/outbox.schema';

/**
 * The traceparent is captured here rather than by the caller: the insert runs inside the producer's
 * active span, and the application layer is barred from importing telemetry.
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
