import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, inArray, isNotNull, lt } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database';
import { RetentionSweepRegistry, type RetentionSweep } from '@shared/retention';
import { outbox } from './schema/outbox.schema';

const DAY_MS = 86_400_000;

/**
 * The `published_at IS NOT NULL` half of the predicate is not decoration: an unpublished row is the
 * relay's work queue, so an old one is a stuck event, not a stale record, and there is deliberately
 * no age at which it becomes collectable. A swept row costs only the audit trail.
 */
@Injectable()
export class SweepPublishedOutbox implements RetentionSweep, OnModuleInit {
  readonly name = 'messaging:outbox';
  private readonly retentionMs: number;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    config: ConfigService,
    private readonly registry: RetentionSweepRegistry,
  ) {
    this.retentionMs = config.getOrThrow<number>('retention.outboxDays') * DAY_MS;
  }

  // Self-registering: a provider added without a matching line elsewhere would be a sweep that
  // exists and never runs, with nothing to report it.
  onModuleInit(): void {
    this.registry.register(this);
  }

  async sweep(batchSize: number): Promise<number> {
    const cutoff = new Date(Date.now() - this.retentionMs);

    // Postgres has no LIMIT on DELETE, so the batch bound comes from a subquery. No
    // `FOR UPDATE SKIP LOCKED` needed — `DELETE ... WHERE id IN (...)` is idempotent between ticks.
    const doomed = this.db
      .select({ id: outbox.id })
      .from(outbox)
      .where(and(isNotNull(outbox.publishedAt), lt(outbox.publishedAt, cutoff)))
      .limit(batchSize);

    const deleted = await this.db.delete(outbox).where(inArray(outbox.id, doomed)).returning({ id: outbox.id });

    return deleted.length;
  }
}
