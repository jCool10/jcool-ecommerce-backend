import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IdentityService, bucketOf } from '../../src/shared/identity';
import { PG_POOL } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { loginAs, sessionHeaders } from '../setup/auth.helper';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { bucketForTestEmail } from '../setup/identity.helper';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// Every primary key in the user context is minted by an adapter, one adapter per table, and each
// mint is reachable only through the request that needs it. This drives all five of them over real
// HTTP and reads the rows back out of Postgres, because the two properties that matter — the id is
// a UUIDv8, and a token sits in its owner's bucket — are invisible to every query the app makes
// until the day the table is split across shards.
describe('Identity routing across the auth paths (integration)', () => {
  let app: INestApplication;
  let pool: Pool;

  const password = 'Password123!';

  // The version nibble of the canonical text form — the same character the DB constraint reads.
  // `bucketOf` covers the variant: it refuses an id whose variant bits are not RFC 9562's.
  const versionNibble = (id: string) => id[14];

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

  async function ownedIds(table: string, userId: string): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM ${table} WHERE user_id = $1 ORDER BY id`, [
      userId,
    ]);
    return rows.map((row) => row.id);
  }

  it('mints a register id in the bucket the address hashes to', async () => {
    const email = 'routing-register@test.local';

    const res = await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);

    const id = res.body.id as string;
    expect(versionNibble(id)).toBe('8');
    expect(bucketOf(id)).toBe(bucketForTestEmail(email));

    // The response could be right while the row is not: the id is minted in the adapter, so the
    // stored value is the one the shard map will read.
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
  });

  it("puts the refresh token a login issues in its owner's bucket", async () => {
    const { user } = await createTestUser(app);

    await loginAs(app, { email: user.email, password });

    const [tokenId, ...extra] = await ownedIds('refresh_tokens', user.id);
    expect(extra).toHaveLength(0);
    expect(versionNibble(tokenId)).toBe('8');
    expect(bucketOf(tokenId)).toBe(bucketOf(user.id));
  });

  // The successor is minted inside the rotation transaction, from a user id read off the locked row
  // rather than passed in — the one mint site with no caller to notice if it regressed to a default.
  it('puts the successor a refresh rotation mints in the same bucket', async () => {
    const { user } = await createTestUser(app);
    const session = await loginAs(app, { email: user.email, password });

    await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(session)).expect(200);

    const { rows } = await pool.query<{ id: string; replaced_by_token_id: string | null }>(
      `SELECT id, replaced_by_token_id FROM refresh_tokens WHERE user_id = $1`,
      [user.id],
    );
    expect(rows).toHaveLength(2);

    // Named from the predecessor's pointer rather than by elimination, so this asserts the row the
    // lineage actually leads to.
    const successorId = rows.find((row) => row.replaced_by_token_id !== null)?.replaced_by_token_id;
    if (!successorId) throw new Error('rotation left no token pointing at a successor');
    expect(rows.map((row) => row.id)).toContain(successorId);

    expect(versionNibble(successorId)).toBe('8');
    expect(bucketOf(successorId)).toBe(bucketOf(user.id));
  });

  it("puts an email-verification token in its owner's bucket", async () => {
    const { user } = await createTestUser(app);

    await request(app.getHttpServer()).post('/auth/resend-verification').send({ email: user.email }).expect(202);

    const [tokenId, ...extra] = await ownedIds('email_verification_tokens', user.id);
    expect(extra).toHaveLength(0);
    expect(versionNibble(tokenId)).toBe('8');
    expect(bucketOf(tokenId)).toBe(bucketOf(user.id));
  });

  it("puts a password-reset token in its owner's bucket", async () => {
    const { user } = await createTestUser(app);

    await request(app.getHttpServer()).post('/auth/forgot-password').send({ email: user.email }).expect(202);

    const [tokenId, ...extra] = await ownedIds('password_reset_tokens', user.id);
    expect(extra).toHaveLength(0);
    expect(versionNibble(tokenId)).toBe('8');
    expect(bucketOf(tokenId)).toBe(bucketOf(user.id));
  });

  // The documented break: a database carrying pre-routing user ids cannot mint tokens at all. It
  // surfaces here rather than as a mysterious 500 the first time someone restores an old dump.
  it('refuses to mint a token for an owner whose id carries no bucket', () => {
    const identity = app.get(IdentityService);

    // By message, not by class: a `TypeError` is also what an undefined argument or a typo'd property
    // access raises, so the class alone would keep passing if the refusal stopped happening.
    expect(() => identity.mintOwnedBy(uuidv7())).toThrow(/Not a UUIDv8/);
  });
});
