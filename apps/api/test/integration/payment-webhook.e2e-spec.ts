import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import {
  authorizeAndRelay,
  placeAndOpenSession,
  postWebhook,
  readOrder,
  readPayment,
  readPaymentOrder,
  readReservation,
  readStock,
  seedSellableSku,
  type OpenOrder,
} from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { checkoutSessionCompleted, checkoutSessionExpired, signWebhookAs } from '../setup/sign-webhook.helper';

const WEBHOOK_SECRET = 'whsec_e2e_test_secret_0123456789';
const STOCK = 5;

describe('Payment webhook (integration, real Postgres, real HMAC)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, {
      METRICS_TOKEN: E2E_METRICS_TOKEN,
    }));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const openOrder = async (): Promise<OpenOrder> =>
    placeAndOpenSession(app, await seedSellableSku(app, { onHand: STOCK }));

  const webhookRows = () => db.select().from(schema.webhookEvents);

  async function expectAuthorized({ orderId }: OpenOrder): Promise<void> {
    expect((await readPayment(app, orderId)).status).toBe('AUTHORIZED');
    expect((await readPaymentOrder(app, orderId)).status).toBe('AUTHORIZED');
    expect((await readOrder(app, orderId)).status).toBe('PENDING');
  }

  async function expectUntouched({ orderId, variantId }: OpenOrder): Promise<void> {
    expect((await readOrder(app, orderId)).status).toBe('PENDING');
    expect((await readReservation(app, orderId, variantId)).status).toBe('HELD');
    expect(await readStock(app, variantId)).toMatchObject({ quantityOnHand: STOCK, quantityReserved: 1 });
  }

  it('authorizes a payment behind its header, which the saga then captures once relayed', async () => {
    const order = await openOrder();

    const { intentId, drained } = await authorizeAndRelay(app, gateway, order, {
      eventId: 'evt_ok_1',
    });

    expect(gateway.captureCalls(intentId)).toBe(1);
    expect((await readPayment(app, order.orderId)).status).toBe('SUCCEEDED');
    expect((await readOrder(app, order.orderId)).status).toBe('PAID');
    expect((await readReservation(app, order.orderId, order.variantId)).status).toBe('COMMITTED');
    expect(await readStock(app, order.variantId)).toMatchObject({ quantityOnHand: STOCK - 1, quantityReserved: 0 });
    expect(drained.map((e) => e.eventType)).toContain('payment.authorized');
  });

  it('rejects a body changed after signing with 401 and writes nothing', async () => {
    const order = await openOrder();
    const intentId = gateway.authorize(order.sessionId);
    const signed = signWebhookAs(
      gateway,
      checkoutSessionCompleted(order.sessionId, order.charge, { eventId: 'evt_tampered', paymentIntent: intentId }),
    );

    const res = await postWebhook(app, { ...signed, rawBody: `${signed.rawBody} ` });

    expect(res.status).toBe(401);
    expect(await webhookRows()).toHaveLength(0);
    await expectUntouched(order);
  });

  it('rejects a signature outside the tolerance window with 401', async () => {
    const order = await openOrder();
    const intentId = gateway.authorize(order.sessionId);
    const signed = signWebhookAs(
      gateway,
      checkoutSessionCompleted(order.sessionId, order.charge, { eventId: 'evt_old_ts', paymentIntent: intentId }),
    );

    const timestamp = signed.headers['stripe-signature'].split(',')[0];
    const oldTimestamp = `t=${Math.floor(Date.now() / 1000) - 3600}`;
    const oldSig = signed.headers['stripe-signature'].replace(timestamp, oldTimestamp);

    const res = await postWebhook(app, { ...signed, headers: { ...signed.headers, 'stripe-signature': oldSig } });

    expect(res.status).toBe(401);
    expect(await webhookRows()).toHaveLength(0);
    await expectUntouched(order);
  });

  it('authorizes a redelivered event id once', async () => {
    const order = await openOrder();
    const intentId = gateway.authorize(order.sessionId);
    const signed = signWebhookAs(
      gateway,
      checkoutSessionCompleted(order.sessionId, order.charge, { eventId: 'evt_dup_1', paymentIntent: intentId }),
    );

    const first = await postWebhook(app, signed);
    const second = await postWebhook(app, signed);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect([first.body, second.body]).toEqual([{ status: 'processed' }, { status: 'duplicate' }]);
    expect(await webhookRows()).toHaveLength(1);
    await expectAuthorized(order);
  });

  it('authorizes two concurrent deliveries of one event once', async () => {
    const order = await openOrder();
    const intentId = gateway.authorize(order.sessionId);
    const signed = signWebhookAs(
      gateway,
      checkoutSessionCompleted(order.sessionId, order.charge, { eventId: 'evt_race_1', paymentIntent: intentId }),
    );

    const results = await Promise.all([postWebhook(app, signed), postWebhook(app, signed)]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => r.body.status).sort()).toEqual(['duplicate', 'processed']);
    expect(await webhookRows()).toHaveLength(1);
    await expectAuthorized(order);
  });

  it('skips a delivery for a session with no local payment', async () => {
    const res = await postWebhook(
      app,
      signWebhookAs(
        gateway,
        checkoutSessionCompleted('cs_orphan_session', { amountMinor: 1, currency: 'VND' }, { eventId: 'evt_orphan' }),
      ),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'skipped' });
    expect(await webhookRows()).toMatchObject([{ providerEventId: 'evt_orphan', status: 'SKIPPED' }]);
  });

  // A session opened before the saga took over checkout has no header: nothing will ever capture or
  // void it, so its webhook changes nothing, and money it reports is a refund owed by hand.
  describe('for a payment with no header', () => {
    async function openWithoutHeader(): Promise<OpenOrder> {
      const order = await openOrder();
      await db.delete(schema.paymentOrders).where(eq(schema.paymentOrders.orderId, order.orderId));
      return order;
    }

    async function refundsOwed(): Promise<number> {
      const { text } = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
      const line = text.split('\n').find((l) => l.startsWith('payment_refund_owed_total{source="webhook_direct"'));
      return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : 0;
    }

    it('skips a paid completion without touching the payment, and counts the refund owed', async () => {
      const order = await openWithoutHeader();
      const before = await refundsOwed();

      const res = await postWebhook(
        app,
        signWebhookAs(
          gateway,
          checkoutSessionCompleted(order.sessionId, order.charge, { eventId: 'evt_unfenced_paid' }),
        ),
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'skipped' });
      expect(await webhookRows()).toMatchObject([{ providerEventId: 'evt_unfenced_paid', status: 'SKIPPED' }]);
      expect((await readPayment(app, order.orderId)).status).toBe('PENDING');
      await expectUntouched(order);
      expect(await refundsOwed()).toBe(before + 1);
    });

    it.each([
      [
        'an unpaid completion',
        (order: OpenOrder) =>
          checkoutSessionCompleted(
            order.sessionId,
            { ...order.charge, paymentStatus: 'unpaid' },
            { eventId: 'evt_unfenced_unpaid' },
          ),
      ],
      ['an expiry', (order: OpenOrder) => checkoutSessionExpired(order.sessionId, { eventId: 'evt_unfenced_expired' })],
    ])('skips %s without counting a refund', async (_label, event) => {
      const order = await openWithoutHeader();
      const before = await refundsOwed();

      const res = await postWebhook(app, signWebhookAs(gateway, event(order)));

      expect(res.body).toEqual({ status: 'skipped' });
      expect((await readPayment(app, order.orderId)).status).toBe('PENDING');
      expect(await refundsOwed()).toBe(before);
    });
  });

  it('ignores an event type it does not act on', async () => {
    const order = await openOrder();

    const res = await postWebhook(
      app,
      signWebhookAs(gateway, {
        id: 'evt_refund',
        type: 'charge.refunded',
        data: { object: { id: order.sessionId } },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ignored' });
    await expectUntouched(order);
  });
});
