import type { INestApplication } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/bearer.helper';
import { drainDomainEvents } from '../setup/domain-events';
import {
  authorizeAndRelay,
  lapseSagaDeadline,
  placeAndOpenSession,
  postAuthorizationWebhook,
  readOrder,
  runSagaUntilSettled,
  seedSellableSku,
  type OpenOrder,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';

const WEBHOOK_SECRET = 'whsec_e2e_saga_events_0123456789';
const ON_HAND = 5;
const QUANTITY = 2;

// Each order status a saga settles on is announced by exactly one outbox row, written in the
// transaction that moved the order there, whatever path got it there and however often it is retried.
describe('Order events emitted by the checkout saga (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let sku: SellableSku;

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  beforeEach(async () => {
    sku = await seedSellableSku(app, { onHand: ON_HAND });
  });

  const orderEvents = async (orderId: string) =>
    (
      await db
        .select()
        .from(schema.outbox)
        .where(eq(schema.outbox.aggregateId, orderId))
        .orderBy(asc(schema.outbox.createdAt))
    ).map(({ eventType, payload }) => ({ eventType, payload }));

  const reportAuthorization = (order: OpenOrder) => postAuthorizationWebhook(app, gateway, order);

  it('announces a placed order once, as order.placed', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);

    expect(await orderEvents(order.orderId)).toEqual([
      { eventType: 'order.placed', payload: expect.objectContaining({ orderId: order.orderId }) },
    ]);
  });

  it('announces a captured order once, as order.paid, even when the authorization is reported again', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    await authorizeAndRelay(app, gateway, order);

    await reportAuthorization(order);
    await drainDomainEvents(app);

    expect((await readOrder(app, order.orderId)).status).toBe('PAID');
    expect((await orderEvents(order.orderId)).map(({ eventType }) => eventType)).toEqual([
      'order.placed',
      'order.paid',
    ]);
  });

  it('announces an order whose hold could not be captured once, as order.failed', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    const intentId = gateway.authorize(order.sessionId);
    await reportAuthorization(order);
    // The hold lapses at Stripe after it was recorded, before the saga gets to capture it.
    gateway.failCapture(intentId, 'expired');

    await drainDomainEvents(app);
    await runSagaUntilSettled(app, order.orderId);

    expect((await readOrder(app, order.orderId)).status).toBe('FAILED');
    expect((await orderEvents(order.orderId)).slice(1)).toEqual([
      {
        eventType: 'order.failed',
        payload: expect.objectContaining({ orderId: order.orderId, reason: 'payment:not_capturable' }),
      },
    ]);
  });

  it('announces an order past its deadline once, as order.expired', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);

    await lapseSagaDeadline(app, order.orderId);
    await runSagaUntilSettled(app, order.orderId);
    await runSagaUntilSettled(app, order.orderId);

    expect((await readOrder(app, order.orderId)).status).toBe('EXPIRED');
    expect((await orderEvents(order.orderId)).slice(1)).toEqual([
      {
        eventType: 'order.expired',
        payload: expect.objectContaining({ orderId: order.orderId, reason: 'saga:deadline' }),
      },
    ]);
  });

  it('announces a cancelled order once, as order.cancelled, however often the buyer cancels', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    const cancel = () =>
      request(app.getHttpServer()).post(`/orders/${order.orderId}/cancel`).set(authHeader(order.token)).expect(200);

    await cancel();
    await cancel();

    expect((await readOrder(app, order.orderId)).status).toBe('CANCELLED');
    expect((await orderEvents(order.orderId)).slice(1)).toEqual([
      {
        eventType: 'order.cancelled',
        payload: expect.objectContaining({ orderId: order.orderId, reason: 'user:cancel' }),
      },
    ]);
  });
});
