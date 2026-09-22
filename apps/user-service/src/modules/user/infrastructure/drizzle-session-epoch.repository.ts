import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../../../database';
import { users } from './schema/user.schema';
import {
  type EpochChange,
  type EpochChangeCursor,
  SESSION_EPOCH_PUBLISHER,
  type SessionEpochChangesPort,
  SessionEpochNotPublishedError,
  type SessionEpochPort,
  type SessionEpochPublisherPort,
} from '../application/ports';

/**
 * `bump` is a single atomic `token_epoch + 1`, so concurrent logout-all calls can't lose an
 * increment. Every revocation flow bumps through here, which is why the publish lives here too.
 */
@Injectable()
export class DrizzleSessionEpochRepository implements SessionEpochPort, SessionEpochChangesPort {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(SESSION_EPOCH_PUBLISHER) private readonly publisher: SessionEpochPublisherPort,
  ) {}

  async current(userId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ tokenEpoch: users.tokenEpoch })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row ? row.tokenEpoch : null;
  }

  async bump(userId: string): Promise<number> {
    const [row] = await this.db
      .update(users)
      .set({ tokenEpoch: sql`${users.tokenEpoch} + 1` })
      .where(eq(users.id, userId))
      .returning({ tokenEpoch: users.tokenEpoch });
    // A bump for a missing user affects no rows; report epoch 0 (nothing to revoke).
    if (!row) return 0;

    // A throw here is a 5xx on a revocation the database already holds; the reconciler publishes
    // it on its next pass.
    try {
      await this.publisher.publish(userId, row.tokenEpoch);
    } catch (error) {
      throw new SessionEpochNotPublishedError(userId, row.tokenEpoch, error);
    }
    return row.tokenEpoch;
  }

  // The cursor stays text: `updated_at` holds microseconds, a Date keeps milliseconds, and a
  // truncated cursor would hand back the rows it was meant to step past.
  listChanges(since: Date, after: EpochChangeCursor | null, limit: number): Promise<EpochChange[]> {
    return this.db
      .select({ userId: users.id, epoch: users.tokenEpoch, updatedAt: sql<string>`${users.updatedAt}::text` })
      .from(users)
      .where(
        after
          ? and(
              gte(users.updatedAt, sql`${after.updatedAt}::timestamptz`),
              sql`(${users.updatedAt}, ${users.id}) > (${after.updatedAt}::timestamptz, ${after.userId}::bigint)`,
            )
          : gte(users.updatedAt, since),
      )
      .orderBy(asc(users.updatedAt), asc(users.id))
      .limit(limit);
  }
}
