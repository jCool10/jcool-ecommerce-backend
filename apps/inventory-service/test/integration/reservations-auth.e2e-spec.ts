import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_EPOCH_KEY_PREFIX } from '@jcool/auth-verifier';
import { RESERVATION_COMMANDS, reservationRoutes } from '@jcool/internal-contracts';
import { authHeader } from '../setup/bearer.helper';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { createTestAdminPrincipal, createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { E2E_API_CALLER_TOKEN } from '../setup/e2e-env';
import { closeAppAfterAll, internalPost, redisOf } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { createTestApp } from '../setup/test-app.factory';
import { userServiceStub } from '../setup/user-service-stub';

const PREVIOUS_API_TOKEN = 'e2e-api-caller-token-previous-not-a-secret-0';

describe('Internal and admin auth (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({ INTERNAL_CALLER_TOKEN_API_PREVIOUS: PREVIOUS_API_TOKEN });
  });
  closeAppAfterAll(() => app);

  const holdUntil = () => new Date(Date.now() + 3_600_000).toISOString();

  describe('internal API', () => {
    const everyRoute = () => {
      const orderId = testId();
      return [
        {
          path: reservationRoutes.try(orderId),
          body: { lines: [{ variantId: testId(), quantity: 1 }], holdUntil: holdUntil() },
        },
        ...RESERVATION_COMMANDS.map((command) => ({
          path: reservationRoutes.command(orderId, command),
          body: undefined,
        })),
        { path: reservationRoutes.status, body: { orderIds: [orderId] } },
      ];
    };

    // A user's access token is no caller credential either: `@Public` lifts the user guard only.
    it('refuses every route with no token, a wrong one or a user access token (401)', async () => {
      const { accessToken } = await createTestAdminPrincipal(app);

      const statuses: string[] = [];
      for (const token of [null, 'not-the-api-caller-token-but-just-as-long-0000', accessToken]) {
        for (const { path, body } of everyRoute()) {
          statuses.push(`${path} ${(await internalPost(app, path, token).send(body)).status}`);
        }
      }

      expect(statuses.filter((line) => !line.endsWith(' 401'))).toEqual([]);
    });

    it('accepts the previous token while the api rolls over', async () => {
      const variantId = testId();
      await seedStock(app, variantId, 1);

      await internalPost(app, reservationRoutes.try(testId()), PREVIOUS_API_TOKEN)
        .send({ lines: [{ variantId, quantity: 1 }], holdUntil: holdUntil() })
        .expect(201);
      await internalPost(app, reservationRoutes.status, PREVIOUS_API_TOKEN)
        .send({ orderIds: [testId()] })
        .expect(200);
    });
  });

  describe('admin API', () => {
    const getStock = (token?: string) => {
      const req = request(app.getHttpServer()).get(`/admin/inventory/${testId()}`);
      return token === undefined ? req : req.set(authHeader(token));
    };

    it('wants an admin token: none is 401, a buyer is 403, an admin reaches the handler', async () => {
      const buyer = await createTestPrincipal(app);
      const admin = await createTestAdminPrincipal(app);

      await getStock().expect(401);
      await getStock(buyer.accessToken).expect(403);
      await getStock(admin.accessToken).expect(404);
    });

    it('refuses the caller token, which grants the internal API only (401)', async () => {
      await getStock(E2E_API_CALLER_TOKEN).expect(401);
    });

    it('refuses an admin whose session was revoked after the token was issued', async () => {
      const { user, accessToken } = await createTestAdminPrincipal(app);
      const epoch = (await userServiceStub()).bumpEpoch(user.id);
      await redisOf(app).set(SESSION_EPOCH_KEY_PREFIX + user.id, String(epoch));

      await getStock(accessToken).expect(401);
    });

    it('asks the user-service for the epoch when Redis has none, and refuses a revoked session', async () => {
      const stub = await userServiceStub();
      const live = await createTestAdminPrincipal(app);
      const revoked = await createTestAdminPrincipal(app);
      stub.bumpEpoch(revoked.user.id);
      await redisOf(app).del(SESSION_EPOCH_KEY_PREFIX + live.user.id, SESSION_EPOCH_KEY_PREFIX + revoked.user.id);
      const asked = stub.calls('epoch');

      await getStock(live.accessToken).expect(404);
      await getStock(revoked.accessToken).expect(401);
      expect(stub.calls('epoch') - asked).toBe(2);
    });
  });
});
