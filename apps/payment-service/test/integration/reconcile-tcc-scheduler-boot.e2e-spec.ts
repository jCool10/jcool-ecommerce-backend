import type { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  PAYMENT_PARTICIPANT,
  type PaymentParticipant,
} from '../../src/modules/payment/application/public/payment-participant.port';
import type { DrizzleDB } from '../../src/database';
import * as schema from '../../src/database/schema';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { eventually } from '../setup/eventually';
import { readPayment, readPaymentOrder } from '../setup/fixtures/payment.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

const WEBHOOK_SECRET = 'whsec_e2e_reconcile_tcc_boot_0001';

// The schedule itself, not the use case: a reconcile e2e that calls the use case directly would stay
// green with the scheduler unwired or unable to boot.
describe('Reconciliation scheduler boot (integration, real Postgres, fake Stripe)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, {
      RECONCILE_ENABLED: 'true',
      RECONCILE_INTERVAL_MS: '1000',
      ORDER_STALE_THRESHOLD_SEC: '0',
    }));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  it('registers its interval when reconcile is enabled', () => {
    expect(app.get(SchedulerRegistry).getIntervals()).toContain('payment-reconcile');
  });

  it('records a hold the webhook never reported, on its own schedule', async () => {
    const orderId = testId();
    const session = await app.get<PaymentParticipant>(PAYMENT_PARTICIPANT).openSession({
      orderId,
      amountMinor: 80_000,
      currency: 'VND',
      expiresAt: new Date(Date.now() + 3 * 60 * 60_000),
    });
    if (session.outcome !== 'OPENED') throw new Error('expected an open session');
    gateway.authorize(session.providerSessionId);

    await eventually(
      async () => (await readPaymentOrder(app, orderId))?.status,
      (status) => status === 'AUTHORIZED',
      10_000,
    );

    expect(await readPayment(app, orderId)).toMatchObject({ status: 'AUTHORIZED' });
    const events = await db.select().from(schema.outbox).where(eq(schema.outbox.eventType, 'payment.authorized'));
    expect(events).toEqual([expect.objectContaining({ payload: expect.objectContaining({ orderId }) })]);
  });
});
