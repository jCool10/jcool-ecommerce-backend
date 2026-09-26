import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '../../../database';
import { IdentityService } from '../application/services/identity.service';
import { refreshTokens, users } from './schema/user.schema';
import type {
  ActiveSession,
  CreateRefreshTokenInput,
  RefreshTokenOwner,
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
      id: await this.identity.mintOwnedBy(input.userId),
      userId: input.userId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
      expiresAt: input.expiresAt,
    });
  }

  async findOwner(tokenHash: string): Promise<RefreshTokenOwner | null> {
    const [row] = await this.db
      .select({
        userId: refreshTokens.userId,
        revokedAt: refreshTokens.revokedAt,
        replacedByTokenId: refreshTokens.replacedByTokenId,
        expiresAt: refreshTokens.expiresAt,
      })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);
    if (!row) return null;
    return {
      userId: row.userId,
      rotatable: row.revokedAt === null && row.replacedByTokenId === null && row.expiresAt.getTime() > Date.now(),
    };
  }

  /**
   * Rotation and reuse detection share one transaction: the presented row is locked `FOR UPDATE`,
   * so two concurrent refreshes of the same token cannot both insert a successor. Takes the shared
   * user lock first (see {@link lockUser}), so a revoke's exclusive lock always waits behind it.
   */
  async rotate(input: RotateRefreshTokenInput): Promise<RotateOutcome> {
    return this.db.transaction(async (tx) => {
      await lockUser(tx, input.expectedUserId, 'shared');

      const [record] = await tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, input.presentedTokenHash))
        .for('update');

      // The successor id carries the bucket of the owner seen before the lock.
      if (!record || record.userId !== input.expectedUserId) {
        return { status: 'invalid' };
      }

      // Retired token replayed → can't tell theft from a late replay, so revoke whatever in the
      // family is still live.
      if (record.revokedAt !== null || record.replacedByTokenId !== null) {
        const revokedSiblings = await tx
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(refreshTokens.familyId, record.familyId), isNull(refreshTokens.revokedAt)))
          .returning({ id: refreshTokens.id });
        return {
          status: 'reuse',
          userId: record.userId,
          familyId: record.familyId,
          // False when nothing live was found — e.g. a repeat replay of an already-revoked family.
          replaced: revokedSiblings.length > 0,
        };
      }

      if (record.expiresAt.getTime() <= Date.now()) {
        await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, record.id));
        return { status: 'invalid' };
      }

      // Unreachable while retirement and expiry stay one-way; refused rather than trusted.
      if (input.successorId === null) {
        return { status: 'invalid' };
      }

      // Owner's role + epoch in the same tx, so the new token's claims are atomic with the rotation (no TOCTOU).
      const [owner] = await tx
        .select({ role: users.role, tokenEpoch: users.tokenEpoch })
        .from(users)
        .where(eq(users.id, record.userId))
        .limit(1);

      const [successor] = await tx
        .insert(refreshTokens)
        .values({
          id: input.successorId,
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

      return { status: 'rotated', userId: record.userId, role: owner.role, tokenEpoch: owner.tokenEpoch };
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
    await this.db.transaction(async (tx) => {
      // Waits out any rotation already in flight, so its successor gets revoked too.
      await lockUser(tx, userId, 'exclusive');
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
    });
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
    return this.db.transaction(async (tx) => {
      // Same reasoning as revokeAllForUser — see there.
      await lockUser(tx, userId, 'exclusive');
      // Scoped by userId: a foreign/unknown family affects no rows (→ false → 404) without leaking its existence.
      const revoked = await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(refreshTokens.userId, userId), eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)),
        )
        .returning({ id: refreshTokens.id });
      return revoked.length > 0;
    });
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

/** Transaction-scoped advisory lock on the user id: shared for rotate, exclusive for a revoke path. */
async function lockUser(tx: DrizzleTx, userId: string, mode: 'shared' | 'exclusive'): Promise<void> {
  const lockFn = mode === 'shared' ? sql`pg_advisory_xact_lock_shared` : sql`pg_advisory_xact_lock`;
  await tx.execute(sql`select ${lockFn}(${userId}::bigint)`);
}
