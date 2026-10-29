import { Inject, Injectable } from '@nestjs/common';
import { injectTraceContext } from '@jcool/platform/observability';
import { UnroutedEventError } from '../errors';
import { type IdMinter, type MessagingModuleOptions, mintOne } from '../messaging.options';
import { MESSAGING_ID_GENERATOR, MESSAGING_OPTIONS } from '../messaging.tokens';
import type { OutboxRecord, OutboxTx, OutboxWriterPort } from '../outbox-port';
import { routeOf } from '../routing/event-routes';
import { outbox } from './schema/outbox.schema';

/**
 * The traceparent is captured here rather than by the caller: the insert runs inside the producer's
 * active span, and the application layer is barred from importing telemetry.
 */
@Injectable()
export class DrizzleOutboxWriter implements OutboxWriterPort {
  constructor(
    @Inject(MESSAGING_ID_GENERATOR) private readonly idGenerator: IdMinter,
    @Inject(MESSAGING_OPTIONS) private readonly options: Pick<MessagingModuleOptions, 'routes'>,
  ) {}

  async append(tx: OutboxTx, record: OutboxRecord, options: { id?: string } = {}): Promise<void> {
    // Before the id is minted: an event nobody routes must fail fast, not after a call to id-service.
    if (!routeOf(this.options.routes, record.eventType)) throw new UnroutedEventError(record.eventType);

    const { traceparent } = injectTraceContext();
    await tx.insert(outbox).values({
      id: options.id ?? (await mintOne(this.idGenerator)),
      aggregateType: record.aggregateType,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      payload: record.payload,
      traceparent: traceparent ?? null,
    });
  }
}
