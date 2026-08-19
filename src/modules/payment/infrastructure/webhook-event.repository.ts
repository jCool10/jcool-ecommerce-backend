import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import { WebhookEvent } from '../domain/webhook-event.entity';
import { WebhookEventStatus } from '../domain/webhook-event-status';
import type {
  InsertWebhookEventResult,
  NewWebhookEvent,
  WebhookEventRepositoryPort,
} from '../application/ports/webhook-event-repository.port';
import { webhookEvents } from './schema/payment.schema';

type WebhookEventRow = typeof webhookEvents.$inferSelect;

/**
 * Drizzle adapter for WebhookEventRepositoryPort. `insertIfNew` relies on the unique
 * (provider, provider_event_id) index as the final idempotency backstop: the INSERT uses
 * ON CONFLICT DO NOTHING, and a suppressed insert (empty returning) means a prior delivery
 * already logged the event — read it back so the caller no-ops instead of double-applying.
 */
@Injectable()
export class DrizzleWebhookEventRepository implements WebhookEventRepositoryPort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async insertIfNew(input: NewWebhookEvent, tx?: DrizzleTx): Promise<InsertWebhookEventResult> {
    const executor = tx ?? this.db;
    const [inserted] = await executor
      .insert(webhookEvents)
      .values({
        provider: input.provider,
        providerEventId: input.providerEventId,
        type: input.type,
        payload: input.payload,
        status: WebhookEventStatus.RECEIVED,
      })
      .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.providerEventId] })
      .returning();

    if (inserted) {
      return { inserted: true, event: toDomain(inserted) };
    }

    const [existing] = await executor
      .select()
      .from(webhookEvents)
      .where(and(eq(webhookEvents.provider, input.provider), eq(webhookEvents.providerEventId, input.providerEventId)))
      .limit(1);
    if (!existing) {
      // The unique conflict suppressed the INSERT, yet the conflicting row is invisible to
      // this executor — only reachable under a snapshot that predates the concurrent commit
      // (REPEATABLE READ / SERIALIZABLE) or a concurrent delete. Fail loud instead of feeding
      // undefined into rehydrate as an opaque TypeError.
      throw new Error(
        `webhook_events conflict on (${input.provider}, ${input.providerEventId}) but the existing row was not readable`,
      );
    }
    return { inserted: false, event: toDomain(existing) };
  }
}

function toDomain(row: WebhookEventRow): WebhookEvent {
  return WebhookEvent.rehydrate({
    id: row.id,
    provider: row.provider,
    providerEventId: row.providerEventId,
    type: row.type,
    payload: row.payload,
    status: row.status,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt,
  });
}
