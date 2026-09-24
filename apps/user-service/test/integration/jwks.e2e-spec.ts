import type { INestApplication } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { authHeader, loginAs } from '../setup/auth.helper';
import { E2E_ES256_KID, E2E_JWT_AUDIENCE, E2E_JWT_ISSUER } from '../setup/e2e-env';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { signEs256WithForeignKey } from '../setup/signing-keys';

describe('JWKS (integration)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  it('publishes the public half of the signing key, cacheable for five minutes, to anyone', async () => {
    const res = await request(app.getHttpServer()).get('/.well-known/jwks.json').expect(200);

    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body.keys).toEqual([
      expect.objectContaining({ kid: E2E_ES256_KID, kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' }),
    ]);
    expect(res.body.keys[0]).not.toHaveProperty('d');
  });

  // What every other service does with a token: fetch the set over HTTP and verify against it.
  it('verifies the tokens login issues through a remote key set', async () => {
    const { user, password } = await createTestUser(app);
    const { accessToken } = await loginAs(app, { email: user.email, password });
    const keys = createRemoteJWKSet(new URL('/.well-known/jwks.json', await app.getUrl()));

    const { payload, protectedHeader } = await jwtVerify(accessToken, keys, {
      algorithms: ['ES256'],
      issuer: E2E_JWT_ISSUER,
      audience: E2E_JWT_AUDIENCE,
    });

    expect(protectedHeader.kid).toBe(E2E_ES256_KID);
    expect(payload).toMatchObject({ sub: user.id, role: user.role, epoch: 0 });
  });

  it('rejects a token under a kid it never published (401)', async () => {
    const { user } = await createTestUser(app);
    const forged = await signEs256WithForeignKey({ sub: user.id }, 'never-published');

    await request(app.getHttpServer()).get('/auth/me').set(authHeader(forged)).expect(401);
  });

  it('rejects a token that claims the active kid but was signed by another key (401)', async () => {
    const { user } = await createTestUser(app);
    const forged = await signEs256WithForeignKey({ sub: user.id }, E2E_ES256_KID);

    await request(app.getHttpServer()).get('/auth/me').set(authHeader(forged)).expect(401);
  });
});
