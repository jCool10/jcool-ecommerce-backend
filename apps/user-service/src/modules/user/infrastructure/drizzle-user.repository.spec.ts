import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '../../../database';
import type { IdentityService } from '../application/services/identity.service';
import { DrizzleUserRepository } from './drizzle-user.repository';

// A real id: the column type refuses anything that would not survive a `bigint` round trip.
const USER_ID = '137465797020397179';

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

describe('DrizzleUserRepository.markEmailVerified', () => {
  it('stamps the verification date only on a row that has none yet', async () => {
    const { db, set, predicateSql } = fakeDb();

    await new DrizzleUserRepository(db, {} as IdentityService).markEmailVerified(USER_ID);

    expect(set.mock.calls[0][0].emailVerifiedAt).toBeInstanceOf(Date);
    expect(predicateSql()).toContain('"email_verified_at" is null');
    expect(predicateSql()).toContain('"id" = $1');
  });
});
