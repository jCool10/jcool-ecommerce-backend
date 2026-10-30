import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { paymentRoutes } from '@jcool/internal-contracts';
import type { DrizzleDB } from '../../src/database';
import * as schema from '../../src/database/schema';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { postWebhook, readPayment, readPaymentOrder } from '../setup/fixtures/payment.fixture';
import {
  closeAppAfterAll,
  createTestAppWithFakeGateway,
  internalPost,
  resetDatabaseBeforeEach,
} from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { checkoutSessionCompleted, signWebhook } from '../setup/sign-webhook.helper';

const WEBHOOK_SECRET = 'whsec_e2e_outbox_secret_0123456789';
const CHARGE = { amountMinor: 150_000, currency: 'VND' };

// The write side only: `published_at` stays NULL for the relay, which is off here.
describe('Transactional outbox append (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  it('appends payment.authorized once in the authorization transaction, however often delivered', async () => {
    const orderId = testId();
    const { body } = await internalPost(app, paymentRoutes.session(orderId))
      .send({ ...CHARGE, expiresAt: new Date(Date.now() + 3 * 3_600_000).toISOString() })
      .expect(200);
    gateway.authorize(body.providerSessionId);
    const signed = signWebhook({
      secret: WEBHOOK_SECRET,
      event: checkoutSessionCompleted(
        body.providerSessionId,
        { ...CHARGE, paymentStatus: 'unpaid' },
        { eventId: 'evt_outbox_authorized' },
      ),
    });

    await postWebhook(app, signed).expect(200, { status: 'processed' });
    await postWebhook(app, signed).expect(200, { status: 'duplicate' });

    const rows = await db.select().from(schema.outbox).where(eq(schema.outbox.aggregateId, body.paymentId));
    expect(rows.map((row) => row.eventType)).toEqual(['payment.authorized']);
    expect(rows[0]).toMatchObject({ aggregateType: 'Payment', publishedAt: null, attempts: 0, traceparent: null });
    expect(rows[0].payload).toEqual({
      paymentId: (await readPayment(app, orderId)).id,
      orderId,
      ...CHARGE,
      authorizedAt: (await readPaymentOrder(app, orderId)).authorizedAt?.toISOString(),
    });
  });
});
