import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader } from '../setup/auth.helper';
import { E2E_CSRF_SECRET, E2E_INTERNAL_API_TOKEN, E2E_JWT_AUDIENCE, E2E_JWT_ISSUER } from '../setup/e2e-env';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { createTestAppWithPool, redisOf, resetDatabaseBeforeEach } from '../setup/harness';
import { publishedEpoch } from '../setup/session-epoch.helper';
import { inProcessIdGenerator } from '../setup/test-app.factory';

const PREVIOUS_INTERNAL_API_TOKEN = 'e2e-internal-api-token-previous-not-a-secret-0';
const INVENTORY_SERVICE_TOKEN = 'e2e-inventory-service-caller-token-not-a-secret';
const PREVIOUS_INVENTORY_SERVICE_TOKEN = 'e2e-inventory-service-previous-token-not-a-secret';
const ORDER_SERVICE_TOKEN = 'e2e-order-service-caller-token-not-a-secret-0';
const PREVIOUS_ORDER_SERVICE_TOKEN = 'e2e-order-service-previous-token-not-a-secret-0';
// Past the default tier's 100 per minute.
const BURST = 150;

describe('Internal service-to-service API (integration)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    // On, so "never throttled" is a claim about the routes rather than about the harness.
    process.env.THROTTLE_ENABLED = 'true';
    ({ app, pool } = await createTestAppWithPool({
      INTERNAL_API_TOKEN_PREVIOUS: PREVIOUS_INTERNAL_API_TOKEN,
      INTERNAL_CALLER_TOKEN_INVENTORY_SERVICE: INVENTORY_SERVICE_TOKEN,
      INTERNAL_CALLER_TOKEN_INVENTORY_SERVICE_PREVIOUS: PREVIOUS_INVENTORY_SERVICE_TOKEN,
      INTERNAL_CALLER_TOKEN_ORDER_SERVICE: ORDER_SERVICE_TOKEN,
      INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS: PREVIOUS_ORDER_SERVICE_TOKEN,
    }));
    await redisOf(app).flushdb();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.THROTTLE_ENABLED;
  });

  resetDatabaseBeforeEach(() => pool);

  const internal = (path: string, token: string | null = E2E_INTERNAL_API_TOKEN): request.Test => {
    const req = request(app.getHttpServer()).get(`/internal/v1${path}`);
    return token === null ? req : req.set(authHeader(token));
  };

  // A real id shape, so the 404 comes from the lookup and not from the id pipe.
  const unknownUserId = async (): Promise<string> => (await inProcessIdGenerator.mint())[0];

  describe('service token', () => {
    it('refuses a call with no token or a wrong one with 401', async () => {
      const { user } = await createTestUser(app);
      const paths = [`/users/${user.id}/summary`, `/sessions/${user.id}/epoch`, '/cutover/digest'];

      const statuses: number[] = [];
      for (const token of [null, 'not-the-internal-token-but-just-as-long-000']) {
        for (const path of paths) statuses.push((await internal(path, token)).status);
      }

      expect(statuses).toEqual(Array(6).fill(401));
    });

    // `@Public` lifts the user guard only; a user's token is not a service credential.
    it("refuses a user's access token (401)", async () => {
      const { user, accessToken } = await createTestUser(app);

      await internal(`/users/${user.id}/summary`, accessToken).expect(401);
    });

    it('accepts the previous token while callers roll over', async () => {
      const { user } = await createTestUser(app);

      await internal(`/sessions/${user.id}/epoch`, PREVIOUS_INTERNAL_API_TOKEN).expect(200);
      await internal('/cutover/digest', PREVIOUS_INTERNAL_API_TOKEN).expect(200);
    });
  });

  describe('caller allowlists', () => {
    // The order.paid mail moved to the order-service, and with it the only reason to read an address.
    it('lets the api read an epoch and the cutover digest, but not a user summary', async () => {
      const { user } = await createTestUser(app);

      await internal(`/sessions/${user.id}/epoch`).expect(200);
      await internal('/cutover/digest').expect(200);
      await internal(`/users/${user.id}/summary`).expect(403);
    });

    it('lets the inventory-service read an epoch and nothing else', async () => {
      const { user } = await createTestUser(app);

      await internal(`/sessions/${user.id}/epoch`, INVENTORY_SERVICE_TOKEN).expect(200);
      await internal(`/sessions/${user.id}/epoch`, PREVIOUS_INVENTORY_SERVICE_TOKEN).expect(200);
      await internal(`/users/${user.id}/summary`, INVENTORY_SERVICE_TOKEN).expect(403);
      await internal('/cutover/digest', INVENTORY_SERVICE_TOKEN).expect(403);
    });

    // Its auth reads epochs, and the order.paid mail reads the buyer's address.
    it('lets the order-service read an epoch and a user summary, but not the cutover digest', async () => {
      const { user } = await createTestUser(app);

      for (const token of [ORDER_SERVICE_TOKEN, PREVIOUS_ORDER_SERVICE_TOKEN]) {
        await internal(`/sessions/${user.id}/epoch`, token).expect(200);
        await internal(`/users/${user.id}/summary`, token).expect(200);
      }
      await internal('/cutover/digest', ORDER_SERVICE_TOKEN).expect(403);
    });
  });

  describe('GET /internal/v1/users/:id/summary', () => {
    it('answers with id, email and role, and nothing else', async () => {
      const { user } = await createTestUser(app);

      const { body } = await internal(`/users/${user.id}/summary`, ORDER_SERVICE_TOKEN).expect(200);

      expect(body).toEqual({ id: user.id, email: user.email, role: user.role });
    });

    it('404s an unknown user', async () => {
      await internal(`/users/${await unknownUserId()}/summary`, ORDER_SERVICE_TOKEN).expect(404);
    });
  });

  describe('GET /internal/v1/sessions/:userId/epoch', () => {
    it('fills auth:epoch from the database and answers with it', async () => {
      const { user } = await createTestUser(app);
      await pool.query(`UPDATE users SET token_epoch = 3 WHERE id = $1`, [user.id]);
      expect(await publishedEpoch(app, user.id)).toBeNull();

      const { body } = await internal(`/sessions/${user.id}/epoch`).expect(200);

      expect(body).toEqual({ epoch: 3 });
      expect(await publishedEpoch(app, user.id)).toBe(3);
    });

    it('404s an unknown user and publishes nothing', async () => {
      const userId = await unknownUserId();

      await internal(`/sessions/${userId}/epoch`).expect(404);

      expect(await publishedEpoch(app, userId)).toBeNull();
    });
  });

  describe('GET /internal/v1/cutover/digest', () => {
    it('fingerprints the secrets this process loaded', async () => {
      const { body } = await internal('/cutover/digest').expect(200);

      // A literal, so a change to the algorithm cannot pass: digests taken earlier must stay comparable.
      expect(body).toEqual({
        csrfSecret: '40c24473c563b622',
        accessTtl: '5m',
        issuer: E2E_JWT_ISSUER,
        audience: E2E_JWT_AUDIENCE,
      });
    });

    it('never answers with a secret itself', async () => {
      const { text } = await internal('/cutover/digest').expect(200);

      expect(text).not.toContain(E2E_CSRF_SECRET);
    });
  });

  // Every caller shares one private address, where a per-IP limit would throttle the caller as a whole.
  // Counters are per route, so each route gets the whole burst.
  it(`never throttles a lookup route, even ${BURST} rapid calls from one address`, async () => {
    const { user } = await createTestUser(app);

    const refused: string[] = [];
    for (const path of [`/users/${user.id}/summary`, `/sessions/${user.id}/epoch`]) {
      for (let i = 0; i < BURST; i++) {
        const { status } = await internal(path, ORDER_SERVICE_TOKEN);
        if (status !== 200) refused.push(`${path} ${status}`);
      }
    }

    expect(refused).toEqual([]);
  });

  it('keeps the internal and well-known routes out of the published API docs', async () => {
    const { body } = await request(app.getHttpServer()).get('/auth/docs-json').expect(200);
    const paths = Object.keys(body.paths as Record<string, unknown>);

    expect(paths).toContain('/auth/login');
    expect(paths.filter((path) => path.startsWith('/internal') || path.startsWith('/.well-known'))).toEqual([]);
  });
});
