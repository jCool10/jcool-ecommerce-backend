import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../../../shared/infrastructure/database/drizzle.tokens';
import { refreshTokens, users } from './schema/user.schema';
import type {
  CreateRefreshTokenInput,
  RefreshTokenRepositoryPort,
  RotateOutcome,
  RotateRefreshTokenInput,
} from '../application/ports/refresh-token-repository.port';

// Drizzle adapter for RefreshTokenRepositoryPort. Only `tokenHash` is stored
// (never the raw token); id/createdAt fall back to the schema defaults.
@Injectable()
export class DrizzleRefreshTokenRepository implements RefreshTokenRepositoryPort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async create(input: CreateRefreshTokenInput): Promise<void> {
    await this.db.insert(refreshTokens).values({
      userId: input.userId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
      expiresAt: input.expiresAt,
    });
  }

  /**
   * Rotation with automatic reuse detection, in one transaction: lock the
   * presented row (`FOR UPDATE`), then — unknown → invalid; revoked/replaced →
   * revoke the whole family and report reuse; expired → invalid; live leaf →
   * insert a successor and point the old row at it. The row lock serializes
   * concurrent rotations.
   */
  async rotate(input: RotateRefreshTokenInput): Promise<RotateOutcome> {
    return this.db.transaction(async (tx) => {
      const [record] = await tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, input.presentedTokenHash))
        .for('update');

      if (!record) {
        return { status: 'invalid' };
      }

      // Retired token replayed. Can't tell attacker-first from victim-late, so
      // revoke the whole family. `replaced` marks the strong theft signal.
      if (record.revokedAt !== null || record.replacedByTokenId !== null) {
        await tx
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(refreshTokens.familyId, record.familyId), isNull(refreshTokens.revokedAt)));
        return {
          status: 'reuse',
          userId: record.userId,
          familyId: record.familyId,
          replaced: record.replacedByTokenId !== null,
        };
      }

      if (record.expiresAt.getTime() <= Date.now()) {
        await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, record.id));
        return { status: 'invalid' };
      }

      // Read the owner's current role in the same transaction so the new access
      // token's claims are atomic with the rotation (no TOCTOU, no second query).
      const [owner] = await tx.select({ role: users.role }).from(users).where(eq(users.id, record.userId)).limit(1);

      const [successor] = await tx
        .insert(refreshTokens)
        .values({
          userId: record.userId,
          tokenHash: input.newTokenHash,
          familyId: record.familyId,
          expiresAt: input.newExpiresAt,
        })
        .returning({ id: refreshTokens.id });

      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date(), replacedByTokenId: successor.id })
        .where(eq(refreshTokens.id, record.id));

      return { status: 'rotated', userId: record.userId, role: owner.role };
    });
  }

  async revoke(userId: string, tokenHash: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(refreshTokens.tokenHash, tokenHash), eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)),
      );
  }
}
