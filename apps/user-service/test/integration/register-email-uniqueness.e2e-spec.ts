import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

// The unique index, not a pre-check, is the only uniqueness guarantee: racing signups resolve to
// one 201 and clean 409s, never a 500 from an unhandled 23505.
describe('Register email uniqueness under concurrency (integration)', () => {
  let app: INestApplication;
  let pool: Pool;

  const password = 'Password123!';

  async function countUsers(email: string): Promise<number> {
    const res = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE email = $1', [email]);
    return res.rows[0].n;
  }

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  it('resolves concurrent same-email signups to one 201, the rest 409, one row', async () => {
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

    expect(await countUsers('user@test.local')).toBe(1);
  });
});
