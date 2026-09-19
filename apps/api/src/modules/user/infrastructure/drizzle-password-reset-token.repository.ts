import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import { IdentityService } from '@shared/identity';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database';
import { passwordResetTokens } from './schema/user.schema';
import type {
  ConsumePasswordResetOutcome,
  CreatePasswordResetTokenInput,
  PasswordResetTokenRepositoryPort,
} from '../application/ports';

@Injectable()
export class DrizzlePasswordResetTokenRepository implements PasswordResetTokenRepositoryPort {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly identity: IdentityService,
  ) {}

  async create(input: CreatePasswordResetTokenInput): Promise<void> {
    await this.db.insert(passwordResetTokens).values({
      id: this.identity.mintOwnedBy(input.userId),
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    });
  }

  /** The WHERE is the guard: only a still-live row consumes, so concurrent submits can't both win. */
  async consume(tokenHash: string): Promise<ConsumePasswordResetOutcome> {
    const now = new Date();
    const [row] = await this.db
      .update(passwordResetTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          isNull(passwordResetTokens.consumedAt),
          gt(passwordResetTokens.expiresAt, now),
        ),
      )
      .returning({ userId: passwordResetTokens.userId });

    return row ? { status: 'consumed', userId: row.userId } : { status: 'invalid' };
  }

  async invalidateAllForUser(userId: string): Promise<void> {
    await this.db
      .update(passwordResetTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.consumedAt)));
  }

  async deleteSpentBefore(cutoff: Date, limit: number): Promise<number> {
    // The negation of `consume`'s guard: a row is collectable exactly when that conditional UPDATE
    // could no longer match it. Postgres has no LIMIT on DELETE, so the batch bound is a subquery.
    const doomed = this.db
      .select({ id: passwordResetTokens.id })
      .from(passwordResetTokens)
      .where(or(lt(passwordResetTokens.expiresAt, cutoff), lt(passwordResetTokens.consumedAt, cutoff)))
      .limit(limit);

    const deleted = await this.db
      .delete(passwordResetTokens)
      .where(inArray(passwordResetTokens.id, doomed))
      .returning({ id: passwordResetTokens.id });
    return deleted.length;
  }
}
