import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../../../shared/infrastructure/database';
import { users } from './schema/user.schema';
import type { SessionEpochPort } from '../application/ports';

/** Drizzle adapter for the session epoch on `users.token_epoch`; `bump` is a single atomic `token_epoch + 1`, so concurrent logout-all calls can't lose an increment. */
@Injectable()
export class DrizzleSessionEpochRepository implements SessionEpochPort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

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
    return row ? row.tokenEpoch : 0;
  }
}
