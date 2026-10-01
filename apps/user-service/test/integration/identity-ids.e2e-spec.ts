import type { INestApplication } from '@nestjs/common';
import { decodeJwt } from 'jose';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { encode, isRoutableId } from '@jcool/id-codec';
import { LEASED_NODE_MAX } from '@jcool/id-generator';
import {
  PASSWORD_HASHER,
  type PasswordHasherPort,
} from '../../src/modules/user/application/ports/password-hasher.port';
import { authHeader, loginAs } from '../setup/auth.helper';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

// Ids are decimal strings end to end, driven over HTTP and read back from Postgres.
describe('User ids across the auth paths (integration)', () => {
  let app: INestApplication;
  let pool: Pool;

  const password = 'Password123!';

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  it('answers register with the id it stored', async () => {
    const email = 'ids-register@test.local';

    const res = await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);

    const id = res.body.id as string;
    expect(isRoutableId(id)).toBe(true);

    const { rows } = await pool.query<{ id: string; type: string }>(
      `SELECT id::text AS id, pg_typeof(id)::text AS type FROM users WHERE email = $1`,
      [email],
    );
    expect(rows).toEqual([{ id, type: 'bigint' }]);
  });

  // Freshly minted ids stay below 2^53 until 2027-02-02, so this one is planted from later: past 2^53,
  // a JSON number, parseInt or Number() anywhere on the path drops digits silently.
  it('hands every digit of an id past 2^53 back through login, the token and /auth/me', async () => {
    const email = 'ids-roundtrip@test.local';
    const id = encode({ tsMs: Date.UTC(2030, 0, 1), nodeId: LEASED_NODE_MAX, sequence: 1 });
    expect(BigInt(id)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));

    const passwordHash = await app.get<PasswordHasherPort>(PASSWORD_HASHER).hash(password);
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [id, email, passwordHash]);

    const session = await loginAs(app, { email, password });
    expect(decodeJwt(session.accessToken).sub).toBe(id);

    const me = await request(app.getHttpServer()).get('/auth/me').set(authHeader(session.accessToken)).expect(200);
    expect(me.body.id).toBe(id);
    expect(me.text).toContain(`"id":"${id}"`);
  });
});
