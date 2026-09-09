import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { IdentityService } from '@shared/identity';
import type { DrizzleDB, DrizzleTx } from '@shared/infrastructure/database';
import { DrizzleUserRepository } from './drizzle-user.repository';

// Repositories are otherwise an e2e concern, but the idempotence of markEmailVerified lives entirely
// in the WHERE clause, which is cheaper and more precise to assert on the compiled predicate.
function fakeDb() {
  let predicate: SQL | undefined;
  const where = vi.fn((clause: SQL) => {
    predicate = clause;
    return Promise.resolve();
  });
  const set = vi.fn((_values: { emailVerifiedAt: Date }) => ({ where }));
  const update = vi.fn(() => ({ set }));
  return {
    db: { update } as unknown as DrizzleDB,
    set,
    predicateSql: () => new PgDialect().sqlToQuery(predicate as SQL).sql,
  };
}

// Just enough of the select chain to see which handle it was issued on.
function fakeReader() {
  const limit = vi.fn().mockResolvedValue([]);
  const from = vi.fn(() => ({ where: vi.fn(() => ({ limit })) }));
  return { select: vi.fn(() => ({ from })) };
}

describe('DrizzleUserRepository', () => {
  describe('findById', () => {
    // The pool handle would check out a connection of its own, which is one too many while the
    // caller's transaction is already holding one.
    it('reads on the caller transaction when it is given one, leaving the pool alone', async () => {
      const pool = fakeReader();
      const tx = fakeReader();

      await new DrizzleUserRepository(pool as unknown as DrizzleDB, {} as IdentityService).findById(
        'u1',
        tx as unknown as DrizzleTx,
      );

      expect(tx.select).toHaveBeenCalled();
      expect(pool.select).not.toHaveBeenCalled();
    });

    it('falls back to the pool when there is no transaction to join', async () => {
      const pool = fakeReader();

      await new DrizzleUserRepository(pool as unknown as DrizzleDB, {} as IdentityService).findById('u1');

      expect(pool.select).toHaveBeenCalled();
    });
  });

  describe('markEmailVerified', () => {
    it('only stamps a row that is not verified yet, so a repeat call keeps the original date', async () => {
      const { db, set, predicateSql } = fakeDb();

      await new DrizzleUserRepository(db, {} as IdentityService).markEmailVerified('u1');

      expect(set.mock.calls[0][0].emailVerifiedAt).toBeInstanceOf(Date);
      expect(predicateSql()).toContain('"email_verified_at" is null');
      expect(predicateSql()).toContain('"id" = $1');
    });
  });
});
