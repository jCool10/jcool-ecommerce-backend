import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../../../shared/infrastructure/database';
import { passwordResetTokens } from './schema/user.schema';
import type {
  ConsumePasswordResetOutcome,
  CreatePasswordResetTokenInput,
  PasswordResetTokenRepositoryPort,
} from '../application/ports';

// Drizzle adapter for PasswordResetTokenRepositoryPort (only tokenHash is stored, never the raw token).
@Injectable()
export class DrizzlePasswordResetTokenRepository implements PasswordResetTokenRepositoryPort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async create(input: CreatePasswordResetTokenInput): Promise<void> {
    await this.db.insert(passwordResetTokens).values({
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    });
  }

  /** Spend the token in one conditional UPDATE (the WHERE is the guard): only a still-live row consumes, so concurrent submits can't both win. */
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
}
