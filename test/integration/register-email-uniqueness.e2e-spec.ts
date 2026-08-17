import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PG_POOL } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// Proves the register write path is race-free: the unique email index — not a
// check-then-insert pre-check — is the sole uniqueness guarantee. Concurrent
// identical signups must resolve to exactly one 201 and clean 409s, never a 500
// from an unhandled Postgres 23505. Over real Postgres + Redis.
describe('Register email uniqueness under concurrency (integration)', () => {
  let app: INestApplication;
  let pool: Pool;

  const password = 'Password123!';

  async function countUsers(email: string): Promise<number> {
    const res = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE email = $1', [email]);
    return res.rows[0].n;
  }

  beforeAll(async () => {
    app = await createTestApp();
    pool = app.get<Pool>(PG_POOL);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  it('resolves N concurrent identical-email signups to exactly one 201, the rest 409, and one DB row', async () => {
    const email = 'race@test.local';
    const attempts = 8;

    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        request(app.getHttpServer()).post('/auth/register').send({ email, password }),
      ),
    );

    const statuses = results.map((r) => r.status);
    const created = statuses.filter((s) => s === 201);
    const conflicts = statuses.filter((s) => s === 409);

    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(attempts - 1);
    // The bug this closes: a losing racer must never surface the raw 23505 as a 500.
    expect(statuses.some((s) => s >= 500)).toBe(false);
    expect(await countUsers(email)).toBe(1);
  });

  it('collapses case variants of the same email to a single account (409 on the rest)', async () => {
    const variants = ['user@test.local', 'User@Test.Local', 'USER@TEST.LOCAL'];

    const first = await request(app.getHttpServer()).post('/auth/register').send({ email: variants[0], password });
    expect(first.status).toBe(201);

    const rest = await Promise.all(
      variants.slice(1).map((email) => request(app.getHttpServer()).post('/auth/register').send({ email, password })),
    );
    for (const res of rest) {
      expect(res.status).toBe(409);
    }

    // All variants normalize (trim + lowercase) to the same canonical address → one row.
    expect(await countUsers('user@test.local')).toBe(1);
  });
});
