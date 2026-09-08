import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import { IdentityService } from '@shared/identity';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database';
import { emailVerificationTokens } from './schema/user.schema';
import type {
  ConsumeEmailVerificationOutcome,
  CreateEmailVerificationTokenInput,
  EmailVerificationTokenRepositoryPort,
} from '../application/ports';

@Injectable()
export class DrizzleEmailVerificationTokenRepository implements EmailVerificationTokenRepositoryPort {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly identity: IdentityService,
  ) {}

  async create(input: CreateEmailVerificationTokenInput): Promise<void> {
    await this.db.insert(emailVerificationTokens).values({
      id: this.identity.mintOwnedBy(input.userId),
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    });
  }

  /** The WHERE is the guard: only a still-live row consumes, so concurrent submits can't both win. */
  async consume(tokenHash: string): Promise<ConsumeEmailVerificationOutcome> {
    const now = new Date();
    const [row] = await this.db
      .update(emailVerificationTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(emailVerificationTokens.tokenHash, tokenHash),
          isNull(emailVerificationTokens.consumedAt),
          gt(emailVerificationTokens.expiresAt, now),
        ),
      )
      .returning({ userId: emailVerificationTokens.userId });

    return row ? { status: 'consumed', userId: row.userId } : { status: 'invalid' };
  }

  async invalidateAllForUser(userId: string): Promise<void> {
    await this.db
      .update(emailVerificationTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(emailVerificationTokens.userId, userId), isNull(emailVerificationTokens.consumedAt)));
  }

  async deleteSpentBefore(cutoff: Date, limit: number): Promise<number> {
    // The negation of `consume`'s guard: a row is collectable exactly when that conditional UPDATE
    // could no longer match it. Postgres has no LIMIT on DELETE, so the batch bound is a subquery.
    const doomed = this.db
      .select({ id: emailVerificationTokens.id })
      .from(emailVerificationTokens)
      .where(or(lt(emailVerificationTokens.expiresAt, cutoff), lt(emailVerificationTokens.consumedAt, cutoff)))
      .limit(limit);

    const deleted = await this.db
      .delete(emailVerificationTokens)
      .where(inArray(emailVerificationTokens.id, doomed))
      .returning({ id: emailVerificationTokens.id });
    return deleted.length;
  }
}
