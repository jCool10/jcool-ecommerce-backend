import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { bucketOf } from '@jcool/id-codec';
import { loginAs, sessionHeaders } from '../setup/auth.helper';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { bucketForTestEmail } from '../setup/identity.helper';

// Every mint site, driven over HTTP and read back from Postgres: no query notices a misrouted id
// until the table is split across shards.
describe('Identity routing across the auth paths (integration)', () => {
  let app: INestApplication;
  let pool: Pool;

  const password = 'Password123!';

  // `bucketOf` checks the variant bits; this is the version nibble the DB constraint reads.
  const versionNibble = (id: string) => id[14];

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  async function ownedIds(table: string, userId: string): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM ${table} WHERE user_id = $1 ORDER BY id`, [
      userId,
    ]);
    return rows.map((row) => row.id);
  }

  // The enumeration-safe routes answer before the token is issued.
  const issuedIds = (table: string, userId: string) =>
    vi.waitFor(async () => {
      const ids = await ownedIds(table, userId);
      expect(ids).not.toHaveLength(0);
      return ids;
    });

  it('mints a register id in the bucket the address hashes to', async () => {
    const email = 'routing-register@test.local';

    const res = await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);

    const id = res.body.id as string;
    expect(versionNibble(id)).toBe('8');
    expect(bucketOf(id)).toBe(bucketForTestEmail(email));

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

  it('puts the successor a refresh rotation mints in the same bucket', async () => {
    const { user } = await createTestUser(app);
    const session = await loginAs(app, { email: user.email, password });

    await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(session)).expect(200);

    const { rows } = await pool.query<{ id: string; replaced_by_token_id: string | null }>(
      `SELECT id, replaced_by_token_id FROM refresh_tokens WHERE user_id = $1`,
      [user.id],
    );
    expect(rows).toHaveLength(2);

    // Followed from the predecessor's pointer, so this is the row the lineage actually leads to.
    const successorId = rows.find((row) => row.replaced_by_token_id !== null)?.replaced_by_token_id;
    if (!successorId) throw new Error('rotation left no token pointing at a successor');
    expect(rows.map((row) => row.id)).toContain(successorId);

    expect(versionNibble(successorId)).toBe('8');
    expect(bucketOf(successorId)).toBe(bucketOf(user.id));
  });

  it("puts an email-verification token in its owner's bucket", async () => {
    const { user } = await createTestUser(app);

    await request(app.getHttpServer()).post('/auth/resend-verification').send({ email: user.email }).expect(202);

    const [tokenId, ...extra] = await issuedIds('email_verification_tokens', user.id);
    expect(extra).toHaveLength(0);
    expect(versionNibble(tokenId)).toBe('8');
    expect(bucketOf(tokenId)).toBe(bucketOf(user.id));
  });

  it("puts a password-reset token in its owner's bucket", async () => {
    const { user } = await createTestUser(app);

    await request(app.getHttpServer()).post('/auth/forgot-password').send({ email: user.email }).expect(202);

    const [tokenId, ...extra] = await issuedIds('password_reset_tokens', user.id);
    expect(extra).toHaveLength(0);
    expect(versionNibble(tokenId)).toBe('8');
    expect(bucketOf(tokenId)).toBe(bucketOf(user.id));
  });
});
