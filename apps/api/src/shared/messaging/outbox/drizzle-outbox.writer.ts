import { Inject, Injectable } from '@nestjs/common';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { ID_GENERATOR, type IdGeneratorPort, mintOne, UNOWNED_BUCKET } from '@shared/identity/id-generator.port';
import { injectTraceContext } from '@jcool/platform/observability';
import type { OutboxRecord, OutboxWriterPort } from './outbox-writer.port';
import { outbox } from './schema/outbox.schema';

/**
 * The traceparent is captured here rather than by the caller: the insert runs inside the producer's
 * active span, and the application layer is barred from importing telemetry.
 */
@Injectable()
export class DrizzleOutboxWriter implements OutboxWriterPort {
  constructor(@Inject(ID_GENERATOR) private readonly ids: IdGeneratorPort) {}

  async append(tx: DrizzleTx, record: OutboxRecord): Promise<void> {
    const { traceparent } = injectTraceContext();
    await tx.insert(outbox).values({
      id: await mintOne(this.ids, UNOWNED_BUCKET),
      aggregateType: record.aggregateType,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      payload: record.payload,
      traceparent: traceparent ?? null,
    });
  }
}
