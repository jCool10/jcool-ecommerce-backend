import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { inArray, lt } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database';
import { RetentionSweepRegistry, type RetentionSweep } from '@jcool/platform/retention';
import { MAX_REDELIVERY_AGE_SEC, MIN_INBOX_RETENTION_DAYS } from '../retry/retry-policy';
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
 * Dead letters have no age limit, so they are not the bound here: `dead-letter.replay.ts` asks the
 * inbox directly before reviving one rather than trusting a clock.
 */
function assertClearsRedeliveryHorizon(days: number): void {
  const retentionSec = days * SEC_PER_DAY;
  if (retentionSec < MAX_REDELIVERY_AGE_SEC) {
    throw new Error(
      `RETENTION_INBOX_DAYS=${days} (${retentionSec}s) is shorter than MAX_REDELIVERY_AGE_SEC ` +
        `(${MAX_REDELIVERY_AGE_SEC}s). A message redelivered after its inbox claim was swept would apply its ` +
        `effect a second time — the exactly-once guarantee would be lost silently. Raise it to at least ` +
        `${MIN_INBOX_RETENTION_DAYS} days.`,
    );
  }
}
