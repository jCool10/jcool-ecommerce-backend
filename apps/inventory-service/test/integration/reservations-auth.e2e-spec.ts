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
import { E2E_CALLER_TOKEN } from '../setup/e2e-env';
import { closeAppAfterAll, internalPost, redisOf } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { createTestApp } from '../setup/test-app.factory';
import { userServiceStub } from '../setup/user-service-stub';

const PREVIOUS_TOKEN = 'e2e-order-service-caller-token-previous-0000';
// What the api called with before checkout left it; Railway may still hold it until the next apply.
const OLD_API_TOKEN = 'e2e-api-caller-token-not-a-real-secret-00000';

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
      INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS: PREVIOUS_TOKEN,
      INTERNAL_CALLER_TOKEN_API: OLD_API_TOKEN,
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

    const statusesWith = async (tokens: (string | null)[]) => {
      const statuses: string[] = [];
      for (const token of tokens) {
        for (const { path, body } of everyRoute()) {
          statuses.push(`${path} ${(await internalPost(app, path, token).send(body)).status}`);
        }
      }
      return statuses;
    };

    // A user's access token is no caller credential either: `@Public` lifts the user guard only.
    it('refuses every route with no token, a wrong one or a user access token (401)', async () => {
      const { accessToken } = await createTestAdminPrincipal(app);

      const statuses = await statusesWith([null, 'not-the-caller-token-but-just-as-long-0000000', accessToken]);

      expect(statuses.filter((line) => !line.endsWith(' 401'))).toEqual([]);
    });

    it('refuses the token the api called with, on every route (401)', async () => {
      const statuses = await statusesWith([OLD_API_TOKEN]);

      expect(statuses.filter((line) => !line.endsWith(' 401'))).toEqual([]);
    });

    it('accepts the order-service, and its previous token while it rolls over', async () => {
      for (const token of [E2E_CALLER_TOKEN, PREVIOUS_TOKEN]) {
        expect(await reserveOne(app, token)).toBe(201);
        await internalPost(app, reservationRoutes.status, token)
          .send({ orderIds: [testId()] })
          .expect(200);
      }
    });

    // The guard refuses a route that names no caller, so a handler-level override could only narrow it.
    it('admits only the order-service on every internal route', () => {
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

      expect(callers).toEqual(handlers.map(() => ['order-service']));
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
      await getStock(E2E_CALLER_TOKEN).expect(401);
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

describe('Boot without a caller token (integration)', () => {
  it('refuses to start, so the internal API is never left open', async () => {
    await expect(createTestApp({ INTERNAL_CALLER_TOKEN_ORDER_SERVICE: undefined })).rejects.toThrow(
      'no internal caller token is set',
    );
  });
});
