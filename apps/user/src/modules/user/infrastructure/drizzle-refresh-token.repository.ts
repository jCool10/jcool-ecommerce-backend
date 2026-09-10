import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import { IdentityService } from '@shared/identity';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database';
import { refreshTokens, users } from './schema/user.schema';
import type {
  ActiveSession,
  CreateRefreshTokenInput,
  RefreshTokenRepositoryPort,
  RotateOutcome,
  RotateRefreshTokenInput,
} from '../application/ports';

@Injectable()
export class DrizzleRefreshTokenRepository implements RefreshTokenRepositoryPort {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly identity: IdentityService,
  ) {}

  async create(input: CreateRefreshTokenInput): Promise<void> {
    await this.db.insert(refreshTokens).values({
      id: this.identity.mintOwnedBy(input.userId),
      userId: input.userId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
      expiresAt: input.expiresAt,
    });
  }

  /**
   * Rotation and reuse detection share one transaction: the presented row is locked `FOR UPDATE`,
   * so two concurrent refreshes of the same token cannot both mint a successor.
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

      // Retired token replayed → can't tell theft from a late replay, so revoke the whole family.
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

      // Owner's claims in the same tx, so the new token's are atomic with the rotation (no TOCTOU).
      const [owner] = await tx
        .select({ role: users.role, email: users.email, tokenEpoch: users.tokenEpoch })
        .from(users)
        .where(eq(users.id, record.userId))
        .limit(1);

      const [successor] = await tx
        .insert(refreshTokens)
        .values({
          id: this.identity.mintOwnedBy(record.userId),
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

      return {
        status: 'rotated',
        userId: record.userId,
        role: owner.role,
        email: owner.email,
        tokenEpoch: owner.tokenEpoch,
      };
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

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }

  async listActiveSessions(userId: string, currentTokenHash: string | null): Promise<ActiveSession[]> {
    // Rotation leaves exactly one live leaf per family, so non-revoked/unexpired rows = one per session (no grouping).
    const rows = await this.db
      .select({
        familyId: refreshTokens.familyId,
        tokenHash: refreshTokens.tokenHash,
        createdAt: refreshTokens.createdAt,
        expiresAt: refreshTokens.expiresAt,
      })
      .from(refreshTokens)
      .where(
        and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date())),
      )
      .orderBy(desc(refreshTokens.createdAt));

    return rows.map((row) => ({
      id: row.familyId,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      current: currentTokenHash !== null && row.tokenHash === currentTokenHash,
    }));
  }

  async revokeFamily(userId: string, familyId: string): Promise<boolean> {
    // Scoped by userId: a foreign/unknown family affects no rows (→ false → 404) without leaking its existence.
    const revoked = await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(refreshTokens.userId, userId), eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)),
      )
      .returning({ id: refreshTokens.id });
    return revoked.length > 0;
  }

  async deleteCollectable(expiredBefore: Date, revokedBefore: Date, limit: number): Promise<number> {
    // Postgres has no LIMIT on DELETE, so the batch bound is a subquery. `isNull(revokedAt)` on the
    // expiry arm is load-bearing — a rotated token has both timestamps set, and without it that arm
    // would collect one long before its revocation grace runs out.
    const doomed = this.db
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(
        or(
          and(lt(refreshTokens.expiresAt, expiredBefore), isNull(refreshTokens.revokedAt)),
          lt(refreshTokens.revokedAt, revokedBefore),
        ),
      )
      .limit(limit);

    const deleted = await this.db
      .delete(refreshTokens)
      .where(inArray(refreshTokens.id, doomed))
      .returning({ id: refreshTokens.id });
    return deleted.length;
  }
}
