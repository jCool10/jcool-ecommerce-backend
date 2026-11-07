import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../../../database';
import { users } from './schema/user.schema';
import {
  type EpochChange,
  type EpochChangeCursor,
  publishEpochOrRaise,
  SESSION_EPOCH_PUBLISHER,
  type SessionEpochChangesPort,
  type SessionEpochPort,
  type SessionEpochPublisherPort,
} from '../application/ports';

/**
 * `bump` is a single atomic `token_epoch + 1`, so concurrent bumps can't lose an increment, and it
 * publishes what it committed. Logout-all and password changes bump inside the refresh-token revoke
 * instead, where the epoch commits with the revoke.
 */
@Injectable()
export class DrizzleSessionEpochRepository implements SessionEpochPort, SessionEpochChangesPort {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(SESSION_EPOCH_PUBLISHER) private readonly sessionEpochPublisher: SessionEpochPublisherPort,
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

    await publishEpochOrRaise(this.sessionEpochPublisher, userId, row.tokenEpoch);
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
