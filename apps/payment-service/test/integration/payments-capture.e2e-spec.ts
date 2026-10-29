import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { isProviderUnavailable, paymentRoutes } from '@jcool/internal-contracts';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { authorizeSession, readPayment, readPaymentOrder } from '../setup/fixtures/payment.fixture';
import {
  closeAppAfterAll,
  createTestAppWithFakeGateway,
  internalPost,
  resetDatabaseBeforeEach,
} from '../setup/harness';
import { testId } from '../setup/id-service-stub';

const WEBHOOK_SECRET = 'whsec_e2e_payments_capture_00001';

// What the saga sees of a capture Stripe half-answered: only the HTTP status and the outcome.
describe('Capture over the internal API (integration, fake Stripe)', () => {
  let app: INestApplication;
  let pool: Pool;
  let gateway: FakeSignerGatewayAdapter;

  beforeAll(async () => {
    ({ app, pool, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  async function authorized() {
    const orderId = testId();
    const { body } = await internalPost(app, paymentRoutes.session(orderId))
      .send({ amountMinor: 150_000, currency: 'VND', expiresAt: new Date(Date.now() + 3 * 3_600_000).toISOString() })
      .expect(200);
    const intentId = await authorizeSession(app, body.providerSessionId, orderId);
    return { orderId, intentId };
  }

  const capture = (orderId: string) => internalPost(app, paymentRoutes.capture(orderId));

  it('answers a capture that landed before its 5xx as captured, and a repeat as idempotent', async () => {
    const { orderId, intentId } = await authorized();
    gateway.failCapture(intentId, 'applied_then_500');

    await capture(orderId).expect(200, { outcome: 'CAPTURED' });
    await capture(orderId).expect(200, { outcome: 'IDEMPOTENT' });

    expect(gateway.captureCalls(intentId)).toBe(1);
    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'CAPTURED' });
  });

  it('answers a capture whose answer was lost with a 503 to retry, the header still authorized', async () => {
    const { orderId, intentId } = await authorized();
    gateway.failCapture(intentId, 'timeout');

    const res = await capture(orderId).expect(503);

    expect(res.headers['retry-after']).toBe('1');
    expect(isProviderUnavailable(res.status, res.body)).toBe(true);
    expect(await readPaymentOrder(app, orderId)).toMatchObject({ status: 'AUTHORIZED' });
    expect(await readPayment(app, orderId)).toMatchObject({ status: 'AUTHORIZED' });

    await capture(orderId).expect(200, { outcome: 'CAPTURED' });
    expect(gateway.captureCalls(intentId)).toBe(1);
  });
});
