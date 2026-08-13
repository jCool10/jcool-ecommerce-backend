import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database';
import { emailVerificationTokens } from './schema/user.schema';
import type {
  ConsumeEmailVerificationOutcome,
  CreateEmailVerificationTokenInput,
  EmailVerificationTokenRepositoryPort,
} from '../application/ports';

// Drizzle adapter for EmailVerificationTokenRepositoryPort (only tokenHash is stored, never the raw token).
@Injectable()
export class DrizzleEmailVerificationTokenRepository implements EmailVerificationTokenRepositoryPort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async create(input: CreateEmailVerificationTokenInput): Promise<void> {
    await this.db.insert(emailVerificationTokens).values({
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    });
  }

  /** Spend the token in one conditional UPDATE (the WHERE is the guard): only a still-live row consumes, so concurrent submits can't both win. */
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
}
