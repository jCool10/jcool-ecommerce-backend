import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authHeader } from '../setup/bearer.helper';
import { LEGACY_AUTH_MODE } from '../setup/e2e-constants';
import { createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { type UserServiceStub, userServiceStub } from '../setup/user-service-stub';

/**
 * One protected route, called through each state the cutover passes through. Both token kinds are in
 * flight at once for up to an access-token lifetime, so each mode has to accept whichever one its
 * epoch source can vouch for.
 */
describe('Access-token verification across the cutover (integration)', () => {
  let stub: UserServiceStub;

  const cart = (app: INestApplication, token: string) =>
    request(app.getHttpServer()).get('/cart').set(authHeader(token));

  beforeAll(async () => {
    stub = await userServiceStub();
  });

  beforeEach(() => stub.reset());

  describe('as the api ships', () => {
    let app: INestApplication;
    let pool: Pool;

    beforeAll(async () => {
      ({ app, pool } = await createTestAppWithPool(LEGACY_AUTH_MODE));
    });
    closeAppAfterAll(() => app);
    resetDatabaseBeforeEach(() => pool);

    it('accepts the HS256 token the api issues', async () => {
      const { accessToken } = await createTestUser(app);

      expect((await cart(app, accessToken)).status).toBe(200);
    });

    it('refuses an ES256 token while no JWKS is configured', async () => {
      const { user } = await createTestUser(app);

      const token = await stub.sign({ id: user.id, email: user.email, role: user.role });

      expect((await cart(app, token)).status).toBe(401);
      expect(stub.calls('jwks')).toBe(0);
    });
  });

  describe('accepting user-service tokens, epochs still from this database', () => {
    let app: INestApplication;
    let pool: Pool;

    beforeAll(async () => {
      ({ app, pool } = await createTestAppWithPool({ ...LEGACY_AUTH_MODE, AUTH_JWKS_URL: stub.jwksUrl }));
    });
    closeAppAfterAll(() => app);
    resetDatabaseBeforeEach(() => pool);

    it('accepts an ES256 token from the user-service for a user this database knows', async () => {
      const { user } = await createTestUser(app);

      const token = await stub.sign({ id: user.id, email: user.email, role: user.role });

      expect((await cart(app, token)).status).toBe(200);
      expect(stub.calls('epoch')).toBe(0);
    });
  });

  describe('epochs from Redis (after the cutover)', () => {
    let app: INestApplication;
    let pool: Pool;

    beforeAll(async () => {
      ({ app, pool } = await createTestAppWithPool());
    });
    closeAppAfterAll(() => app);
    resetDatabaseBeforeEach(() => pool);

    it('accepts an ES256 token from the user-service', async () => {
      const { accessToken } = await createTestPrincipal(app);

      expect((await cart(app, accessToken)).status).toBe(200);
    });

    it('still accepts an HS256 token the api issued before the cutover', async () => {
      const { user, accessToken } = await createTestUser(app);
      // Copied to the user-service, but its epoch has not reached Redis yet.
      stub.register({ id: user.id, email: user.email, role: user.role });

      expect((await cart(app, accessToken)).status).toBe(200);
      expect(stub.calls('epoch')).toBe(1);
    });
  });

  describe('with HS256 switched off', () => {
    let app: INestApplication;
    let pool: Pool;

    beforeAll(async () => {
      ({ app, pool } = await createTestAppWithPool({ AUTH_HS256_ENABLED: 'false' }));
    });
    closeAppAfterAll(() => app);
    resetDatabaseBeforeEach(() => pool);

    it("refuses the api's own tokens and keeps accepting the user-service's", async () => {
      const legacy = await createTestUser(app);
      stub.register({ id: legacy.user.id, email: legacy.user.email, role: legacy.user.role });
      const { accessToken } = await createTestPrincipal(app);

      expect((await cart(app, legacy.accessToken)).status).toBe(401);
      expect((await cart(app, accessToken)).status).toBe(200);
    });
  });
});
