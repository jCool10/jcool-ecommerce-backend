import type { INestApplication } from '@nestjs/common';
import { decodeJwt } from 'jose';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { bucketOf, isRoutableId } from '@jcool/id-codec';
import { authHeader, loginAs } from '../setup/auth.helper';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { bucketForTestEmail } from '../setup/identity.helper';

// An id is a 63-bit integer in Postgres and a decimal string on the wire, and it is already past
// 2^53 — so anything that routes it through a JSON number, a `parseInt`, or a `Number()` drops its
// last digits without an error. Every assertion here compares the digits, never the numeric value.
describe('Id wire format (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;

  const password = 'Password123!';

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  it('registers a user whose id is a decimal string past what a JSON number holds', async () => {
    const email = 'id-format-register@test.local';

    const res = await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);

    const id = res.body.id as string;
    expect(id).toMatch(/^[1-9][0-9]*$/);
    expect(isRoutableId(id)).toBe(true);
    expect(bucketOf(id)).toBe(bucketForTestEmail(email));
    // The point of sending it as a string: as a JSON number this value would not survive a parse.
    expect(BigInt(id)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    // Read off the raw body, so a number in the payload fails here rather than after supertest has
    // already parsed it into a lossy double.
    expect(res.text).toContain(`"id":"${id}"`);
  });

  it('stores that id as an integer and hands back every digit of it', async () => {
    const email = 'id-format-roundtrip@test.local';

    const registered = await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);
    const id = registered.body.id as string;

    const { rows } = await pool.query<{ id: string; type: string }>(
      `SELECT u.id::text AS id, pg_typeof(u.id)::text AS type FROM users u WHERE u.email = $1`,
      [email],
    );
    expect(rows[0]).toEqual({ id, type: 'bigint' });

    const session = await loginAs(app, { email, password });
    expect(decodeJwt(session.accessToken).sub).toBe(id);

    const me = await request(app.getHttpServer()).get('/auth/me').set(authHeader(session.accessToken)).expect(200);
    expect(me.body.id).toBe(id);
    expect(me.text).toContain(`"id":"${id}"`);
  });
});
