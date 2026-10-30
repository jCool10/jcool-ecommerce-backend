import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { paymentRoutes } from '@jcool/internal-contracts';
import { INTERNAL_CALLERS_KEY } from '@jcool/platform/internal-api';
import { PaymentsController } from '../../src/modules/payment/interface/internal/payments.controller';
import { closeAppAfterAll, internalPost } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { createTestApp } from '../setup/test-app.factory';

const PREVIOUS_API_TOKEN = 'e2e-api-caller-token-previous-not-a-secret-0';
const ORDER_SERVICE_TOKEN = 'e2e-order-service-caller-token-not-a-secret-0';

describe('Internal API auth (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({
      INTERNAL_CALLER_TOKEN_API_PREVIOUS: PREVIOUS_API_TOKEN,
      INTERNAL_CALLER_TOKEN_ORDER_SERVICE: ORDER_SERVICE_TOKEN,
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

  it('refuses every route with no token or a wrong one (401)', async () => {
    const statuses: string[] = [];
    for (const token of [null, 'not-the-api-caller-token-but-just-as-long-0000']) {
      for (const { path, body } of everyRoute()) {
        statuses.push(`${path} ${(await internalPost(app, path, token).send(body)).status}`);
      }
    }

    expect(statuses.filter((line) => !line.endsWith(' 401'))).toEqual([]);
  });

  it('accepts the previous token while the api rolls over', async () => {
    await internalPost(app, paymentRoutes.cancel(testId()), PREVIOUS_API_TOKEN).expect(200, { outcome: 'FENCED' });
    await internalPost(app, paymentRoutes.status, PREVIOUS_API_TOKEN)
      .send({ orderIds: [testId()] })
      .expect(200);
  });

  it('accepts the order-service, which takes checkout over from the api', async () => {
    await internalPost(app, paymentRoutes.cancel(testId()), ORDER_SERVICE_TOKEN).expect(200, { outcome: 'FENCED' });
    await internalPost(app, paymentRoutes.status, ORDER_SERVICE_TOKEN)
      .send({ orderIds: [testId()] })
      .expect(200);
  });

  // The guard refuses a route that names no caller, so a handler-level override could only narrow it.
  it('admits the api and the order-service on every internal route', () => {
    const reflector = app.get(Reflector);
    const handlers = ['openSession', 'capture', 'cancel', 'status'] as const;

    // Only a metadata target, never called.
    const handlerOf = (name: string) =>
      Object.getOwnPropertyDescriptor(PaymentsController.prototype, name)?.value as () => unknown;
    const callers = handlers.map((name) =>
      reflector.getAllAndOverride<string[] | undefined>(INTERNAL_CALLERS_KEY, [handlerOf(name), PaymentsController]),
    );

    expect(callers).toEqual(handlers.map(() => ['api', 'order-service']));
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
      await internalPost(app, paymentRoutes.cancel(testId()), ORDER_SERVICE_TOKEN).expect(200);
      await internalPost(app, paymentRoutes.cancel(testId())).expect(401);
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
