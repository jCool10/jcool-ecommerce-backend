import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { inArray, lt } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database';
import { RetentionSweepRegistry, type RetentionSweep } from '@shared/retention';
import { MIN_INBOX_RETENTION_DAYS, REMOVE_ON_FAIL_AGE_SEC } from '../queue/queue.constants';
import { inbox } from './schema/inbox.schema';

const DAY_MS = 86_400_000;
const SEC_PER_DAY = 86_400;

/**
 * A correctness bound, not housekeeping. The claim and the effect commit together, so a redelivery
 * finds the claim and does nothing. Delete the claim while the message can still be redelivered and
 * the effect is applied twice — silently, and during an incident, because that is when retries happen.
 */
@Injectable()
export class SweepInbox implements RetentionSweep, OnModuleInit {
  readonly name = 'messaging:inbox';
  private readonly retentionMs: number;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    config: ConfigService,
    private readonly registry: RetentionSweepRegistry,
  ) {
    const days = config.getOrThrow<number>('retention.inboxDays');
    assertClearsRedeliveryHorizon(days);
    this.retentionMs = days * DAY_MS;
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  async sweep(batchSize: number): Promise<number> {
    const cutoff = new Date(Date.now() - this.retentionMs);

    const doomed = this.db.select({ id: inbox.id }).from(inbox).where(lt(inbox.processedAt, cutoff)).limit(batchSize);

    const deleted = await this.db.delete(inbox).where(inArray(inbox.id, doomed)).returning({ id: inbox.id });

    return deleted.length;
  }
}

/**
 * The horizon to clear is the main queue's failed-job retention, not the DLQ's — the DLQ has no age
 * limit at all, so there is no bound to compare against. Its unbounded horizon is handled instead by
 * `dead-letter.replay.ts`, which asks the inbox directly rather than trusting a clock.
 */
function assertClearsRedeliveryHorizon(days: number): void {
  const retentionSec = days * SEC_PER_DAY;
  if (retentionSec < REMOVE_ON_FAIL_AGE_SEC) {
    throw new Error(
      `RETENTION_INBOX_DAYS=${days} (${retentionSec}s) is shorter than the queue's failed-job retention ` +
        `(${REMOVE_ON_FAIL_AGE_SEC}s). A failed job re-run after its inbox claim was swept would apply its ` +
        `effect a second time — the exactly-once guarantee would be lost silently. Raise it to at least ` +
        `${MIN_INBOX_RETENTION_DAYS} days.`,
    );
  }
}
