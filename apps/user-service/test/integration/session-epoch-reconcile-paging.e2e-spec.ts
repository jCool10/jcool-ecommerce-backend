import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SESSION_EPOCH_KEY_PREFIX } from '@jcool/auth-verifier';
import type { DrizzleDB } from '../../src/database';
import {
  SESSION_EPOCH_CHANGES,
  type SessionEpochChangesPort,
} from '../../src/modules/user/application/ports/session-epoch-changes.port';
import { SessionEpochReconciler } from '../../src/modules/user/application/services/session-epoch-reconciler';
import { users } from '../../src/modules/user/infrastructure/schema/user.schema';
import { closeAppAfterAll, createTestAppWithPool, redisOf, resetDatabaseBeforeEach } from '../setup/harness';
import { bucketForTestEmail } from '../setup/identity.helper';
import { publishedEpoch } from '../setup/session-epoch.helper';
import { inProcessIdGenerator } from '../setup/test-app.factory';

// SessionEpochReconciler's page size.
const PAGE_SIZE = 500;

describe('Session epoch reconcile paging (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  async function seedUsers(count: number, updatedAt: Date): Promise<string[]> {
    const rows = [];
    for (let i = 0; i < count; i++) {
      const email = `paging-${i}@test.local`;
      const [id] = await inProcessIdGenerator.mint(bucketForTestEmail(email));
      rows.push({ id, email, passwordHash: 'not-a-real-hash', updatedAt });
    }
    await db.insert(users).values(rows);
    return rows.map((row) => row.id);
  }

  it('republishes a bump Redis never saw when it sorts onto the second page', async () => {
    const stamp = new Date();
    // One shared timestamp across the page boundary, so page two is found by the id half of the cursor.
    const ids = await seedUsers(PAGE_SIZE + 2, stamp);
    const [lost] = ids;
    await pool.query(`UPDATE users SET token_epoch = token_epoch + 1, updated_at = $2 WHERE id = $1`, [
      lost,
      new Date(stamp.getTime() + 1),
    ]);
    const listChanges = vi.spyOn(app.get<SessionEpochChangesPort>(SESSION_EPOCH_CHANGES), 'listChanges');

    await app.get(SessionEpochReconciler).reconcileOnce();

    expect(listChanges).toHaveBeenCalledTimes(2);
    expect(await publishedEpoch(app, lost)).toBe(1);
    const published = await redisOf(app).mget(ids.map((id) => SESSION_EPOCH_KEY_PREFIX + id));
    expect(published.filter((epoch) => epoch === null)).toEqual([]);
    listChanges.mockRestore();
  });
});
