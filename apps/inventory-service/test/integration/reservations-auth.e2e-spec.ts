import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_EPOCH_KEY_PREFIX } from '@jcool/auth-verifier';
import { RESERVATION_COMMANDS, reservationRoutes } from '@jcool/internal-contracts';
import { INTERNAL_CALLERS_KEY } from '@jcool/platform/internal-api';
import { ReservationsController } from '../../src/modules/inventory/interface/internal/reservations.controller';
import { authHeader } from '../setup/bearer.helper';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { createTestAdminPrincipal, createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { E2E_API_CALLER_TOKEN } from '../setup/e2e-env';
import { closeAppAfterAll, internalPost, redisOf } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { createTestApp } from '../setup/test-app.factory';
import { userServiceStub } from '../setup/user-service-stub';

const PREVIOUS_API_TOKEN = 'e2e-api-caller-token-previous-not-a-secret-0';
const ORDER_SERVICE_TOKEN = 'e2e-order-service-caller-token-not-a-secret-0';

const holdUntil = () => new Date(Date.now() + 3_600_000).toISOString();

async function reserveOne(app: INestApplication, token: string): Promise<number> {
  const variantId = testId();
  await seedStock(app, variantId, 1);
  const { status } = await internalPost(app, reservationRoutes.try(testId()), token).send({
    lines: [{ variantId, quantity: 1 }],
    holdUntil: holdUntil(),
  });
  return status;
}

describe('Internal and admin auth (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({
      INTERNAL_CALLER_TOKEN_API_PREVIOUS: PREVIOUS_API_TOKEN,
      INTERNAL_CALLER_TOKEN_ORDER_SERVICE: ORDER_SERVICE_TOKEN,
    });
  });
  closeAppAfterAll(() => app);

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
      expect(await reserveOne(app, PREVIOUS_API_TOKEN)).toBe(201);
      await internalPost(app, reservationRoutes.status, PREVIOUS_API_TOKEN)
        .send({ orderIds: [testId()] })
        .expect(200);
    });

    it('accepts the order-service, which takes checkout over from the api', async () => {
      expect(await reserveOne(app, ORDER_SERVICE_TOKEN)).toBe(201);
      await internalPost(app, reservationRoutes.status, ORDER_SERVICE_TOKEN)
        .send({ orderIds: [testId()] })
        .expect(200);
    });

    // The guard refuses a route that names no caller, so a handler-level override could only narrow it.
    it('admits the api and the order-service on every internal route', () => {
      const reflector = app.get(Reflector);
      const handlers = ['tryReserve', 'commit', 'release', 'restock', 'status'] as const;

      // Only a metadata target, never called.
      const handlerOf = (name: string) =>
        Object.getOwnPropertyDescriptor(ReservationsController.prototype, name)?.value as () => unknown;
      const callers = handlers.map((name) =>
        reflector.getAllAndOverride<string[] | undefined>(INTERNAL_CALLERS_KEY, [
          handlerOf(name),
          ReservationsController,
        ]),
      );

      expect(callers).toEqual(handlers.map(() => ['api', 'order-service']));
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

// The api's token is dropped while this service still runs, so no single caller may be required.
describe('Boot with caller tokens (integration)', () => {
  it('starts with the order-service as its only caller', async () => {
    const app = await createTestApp({
      INTERNAL_CALLER_TOKEN_API: undefined,
      INTERNAL_CALLER_TOKEN_ORDER_SERVICE: ORDER_SERVICE_TOKEN,
    });
    try {
      expect(await reserveOne(app, ORDER_SERVICE_TOKEN)).toBe(201);
      expect(await reserveOne(app, E2E_API_CALLER_TOKEN)).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('refuses to start with none, so the internal API is never left open', async () => {
    await expect(createTestApp({ INTERNAL_CALLER_TOKEN_API: undefined })).rejects.toThrow(
      'no internal caller token is set',
    );
  });
});
