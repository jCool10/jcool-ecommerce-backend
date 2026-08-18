import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lt } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import type {
  IdempotencyRecord,
  IdempotencyStorePort,
  InsertInProgressInput,
  MarkCompletedInput,
} from '../application/ports/idempotency-store.port';
import { idempotencyKeys } from './schema/idempotency-key.schema';

type Row = typeof idempotencyKeys.$inferSelect;

/**
 * Drizzle adapter for IdempotencyStorePort. `tryInsertInProgress` pushes the race down to the
 * unique (scope, key) index via ON CONFLICT DO NOTHING — one writer wins, the rest get null,
 * no read-modify-write window. `markCompleted` / `deleteInProgress` accept an optional tx so
 * they can enlist in the checkout transaction (key + order + reservation commit together).
 */
@Injectable()
export class DrizzleIdempotencyKeyRepository implements IdempotencyStorePort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async tryInsertInProgress(input: InsertInProgressInput): Promise<IdempotencyRecord | null> {
    const [row] = await this.db
      .insert(idempotencyKeys)
      .values({
        scope: input.scope,
        key: input.key,
        requestHash: input.requestHash,
        method: input.method,
        path: input.path,
        expiresAt: input.expiresAt,
      })
      .onConflictDoNothing({ target: [idempotencyKeys.scope, idempotencyKeys.key] })
      .returning();
    return row ? toRecord(row) : null;
  }

  async findByScopeAndKey(scope: string, key: string): Promise<IdempotencyRecord | null> {
    const [row] = await this.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async markCompleted(input: MarkCompletedInput, tx?: DrizzleTx): Promise<void> {
    const exec = tx ?? this.db;
    await exec
      .update(idempotencyKeys)
      .set({
        status: 'COMPLETED',
        responseStatus: input.responseStatus,
        responseBody: input.responseBody,
        orderId: input.orderId ?? null,
      })
      .where(and(eq(idempotencyKeys.scope, input.scope), eq(idempotencyKeys.key, input.key)));
  }

  async deleteInProgress(scope: string, key: string, tx?: DrizzleTx): Promise<void> {
    const exec = tx ?? this.db;
    await exec
      .delete(idempotencyKeys)
      .where(
        and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key), eq(idempotencyKeys.status, 'IN_PROGRESS')),
      );
  }

  async deleteExpiredInProgress(scope: string, key: string, now: Date): Promise<number> {
    const deleted = await this.db
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.scope, scope),
          eq(idempotencyKeys.key, key),
          eq(idempotencyKeys.status, 'IN_PROGRESS'),
          lt(idempotencyKeys.expiresAt, now),
        ),
      )
      .returning({ id: idempotencyKeys.id });
    return deleted.length;
  }

  async deleteExpired(now: Date): Promise<number> {
    const deleted = await this.db
      .delete(idempotencyKeys)
      .where(lt(idempotencyKeys.expiresAt, now))
      .returning({ id: idempotencyKeys.id });
    return deleted.length;
  }
}

function toRecord(row: Row): IdempotencyRecord {
  return {
    id: row.id,
    scope: row.scope,
    key: row.key,
    requestHash: row.requestHash,
    status: row.status,
    responseStatus: row.responseStatus,
    responseBody: row.responseBody,
    orderId: row.orderId,
    method: row.method,
    path: row.path,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}
