import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { paymentRoutes } from '@jcool/internal-contracts';
import { INTERNAL_CALLERS_KEY } from '@jcool/platform/internal-api';
import { PaymentsController } from '../../src/modules/payment/interface/internal/payments.controller';
import { closeAppAfterAll, internalPost } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { createTestApp } from '../setup/test-app.factory';

const PREVIOUS_TOKEN = 'e2e-order-service-caller-token-previous-0000';
// What the api called with before checkout left it; Railway may still hold it until the next apply.
const OLD_API_TOKEN = 'e2e-api-caller-token-not-a-real-secret-00000';

describe('Internal API auth (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({
      INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS: PREVIOUS_TOKEN,
      INTERNAL_CALLER_TOKEN_API: OLD_API_TOKEN,
    });
  });
  closeAppAfterAll(() => app);

  const everyRoute = () => {
    const orderId = testId();
    return [
      {
        path: paymentRoutes.session(orderId),
        body: { amountMinor: 150_000, currency: 'VND', expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
      },
      { path: paymentRoutes.capture(orderId), body: undefined },
      { path: paymentRoutes.cancel(orderId), body: undefined },
      { path: paymentRoutes.status, body: { orderIds: [orderId] } },
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

  it('refuses every route with no token or a wrong one (401)', async () => {
    const statuses = await statusesWith([null, 'not-the-caller-token-but-just-as-long-0000000']);

    expect(statuses.filter((line) => !line.endsWith(' 401'))).toEqual([]);
  });

  it('refuses the token the api called with, on every route (401)', async () => {
    const statuses = await statusesWith([OLD_API_TOKEN]);

    expect(statuses.filter((line) => !line.endsWith(' 401'))).toEqual([]);
  });

  it('accepts the order-service, and its previous token while it rolls over', async () => {
    for (const token of [undefined, PREVIOUS_TOKEN]) {
      await internalPost(app, paymentRoutes.cancel(testId()), token).expect(200, { outcome: 'FENCED' });
      await internalPost(app, paymentRoutes.status, token)
        .send({ orderIds: [testId()] })
        .expect(200);
    }
  });

  // The guard refuses a route that names no caller, so a handler-level override could only narrow it.
  it('admits only the order-service on every internal route', () => {
    const reflector = app.get(Reflector);
    const handlers = ['openSession', 'capture', 'cancel', 'status'] as const;

    // Only a metadata target, never called.
    const handlerOf = (name: string) =>
      Object.getOwnPropertyDescriptor(PaymentsController.prototype, name)?.value as () => unknown;
    const callers = handlers.map((name) =>
      reflector.getAllAndOverride<string[] | undefined>(INTERNAL_CALLERS_KEY, [handlerOf(name), PaymentsController]),
    );

    expect(callers).toEqual(handlers.map(() => ['order-service']));
  });
});

describe('Boot without a caller token (integration)', () => {
  it('refuses to start, so the internal API is never left open', async () => {
    await expect(createTestApp({ INTERNAL_CALLER_TOKEN_ORDER_SERVICE: undefined })).rejects.toThrow(
      'no internal caller token is set',
    );
  });
});
