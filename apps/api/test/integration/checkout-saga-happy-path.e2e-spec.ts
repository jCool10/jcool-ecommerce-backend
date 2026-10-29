import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { ORDER_EVENTS_QUEUE } from '@jcool/internal-contracts/queues/order-events';
import { DomainEventProcessor } from '@jcool/messaging';
import { authHeader } from '../setup/bearer.helper';
import { orderEventTypes, relayedAuthorizations, sagaHandle } from '../setup/fixtures/checkout-saga.fixture';
import { readReservationOrder } from '../setup/fixtures/inventory.fixture';
import {
  auditLedgerInvariants,
  authorizePayment,
  buyerWithCart,
  checkout,
  openSession,
  readPaymentOrder,
  readStock,
  seedSellableSku,
  untilOrderStatus,
} from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetSagasAndDatabaseBeforeEach } from '../setup/harness';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { type PaymentServiceStub, paymentServiceStub } from '../setup/payment-service-stub';

const PRICE = 90_000;
const ON_HAND = 5;
const DELIVERIES = 3;

describe('Checkout saga happy path (integration, real Temporal, real HTTP, fake Stripe)', () => {
  let app: INestApplication;
  let pool: Pool;
  let payment: PaymentServiceStub;

  beforeAll(async () => {
    payment = await paymentServiceStub();
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app],
    () => pool,
  );

  it('takes a checkout to PAID with one capture, however often the provider redelivers the webhook', async () => {
    const sku = await seedSellableSku(app, { onHand: ON_HAND, priceMinor: PRICE });
    const token = await buyerWithCart(app, sku.variantId, 2);

    const placed = await checkout(app, token).expect(201);
    const orderId = placed.body.id as string;
    expect(placed.body).toMatchObject({ status: 'PENDING', totalAmountMinor: 2 * PRICE });
    expect((await readStock(app, sku.variantId))?.quantityReserved).toBe(2);

    await openSession(app, token, orderId).expect(201);
    await authorizePayment(orderId);
    // Payment dedups the webhook itself; what reaches the api more than once is the job.
    const [job, ...others] = await relayedAuthorizations(app, orderId);
    expect(others).toEqual([]);
    const processor = app.get(DomainEventProcessor);
    const answers: string[] = [];
    for (let delivery = 0; delivery < DELIVERIES; delivery++) {
      answers.push(await processor.process(job.data, ORDER_EVENTS_QUEUE));
    }
    await job.remove();
    expect(answers).toEqual(['processed', 'duplicate', 'duplicate']);

    await untilOrderStatus(app, orderId, 'PAID');

    expect(await sagaHandle(app, orderId).result()).toBe('COMPLETED');
    expect(payment.providerCaptures(orderId)).toBe(1);
    expect((await readReservationOrder(app, orderId))?.status).toBe('COMMITTED');
    expect((await readPaymentOrder(app, orderId))?.status).toBe('CAPTURED');
    expect(await orderEventTypes(app, orderId)).toEqual(['order.placed', 'order.paid']);
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: ON_HAND - 2, quantityReserved: 0 });

    const view = await request(app.getHttpServer()).get(`/orders/${orderId}`).set(authHeader(token)).expect(200);
    expect(view.body).toMatchObject({ id: orderId, status: 'PAID' });
    expect(view.body).toHaveProperty('finalizeReason');

    const audit = await auditLedgerInvariants(app, { [sku.variantId]: ON_HAND });
    expect(audit).toEqual({ orders: 1, pending: [], violations: [] });
  });

  it('replays the placed order for a retried checkout and runs one saga for it', async () => {
    const sku = await seedSellableSku(app, { onHand: ON_HAND, priceMinor: PRICE });
    const token = await buyerWithCart(app, sku.variantId);
    const key = idempotencyKeyHeader();
    const post = () => request(app.getHttpServer()).post('/orders').set(authHeader(token)).set(key);

    const first = await post().expect(201);
    const replay = await post().expect(201);

    expect(replay.body).toEqual(first.body);
    expect(await orderEventTypes(app, first.body.id as string)).toEqual(['order.placed']);
    expect((await readStock(app, sku.variantId))?.quantityReserved).toBe(1);
    expect((await sagaHandle(app, first.body.id as string).describe()).status.name).toBe('RUNNING');
  });
});
