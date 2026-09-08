import type { INestApplication } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { FinalizeOrderUseCase, SweepExpiredReservationsUseCase } from '../../src/modules/order/application/use-cases';
import { OrderStatus } from '../../src/modules/order/domain/order-status';
import { PAYMENT_GATEWAY } from '../../src/modules/payment/application/ports/payment-gateway.port';
import { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';
import { DomainEventProcessor } from '../../src/shared/messaging/queue/domain-event.processor';
import { PaymentStatus } from '../../src/modules/payment/domain/payment-status';
import { authHeader } from '../setup/auth.helper';
import { createTestUser } from '../setup/fixtures/user.fixture';
import {
  buyerWithCart,
  checkout,
  placeAndOpenSession,
  postWebhook,
  readOrder,
  readPayment,
  readStock,
  seedSellableSku,
  signOutcome,
  type OpenOrder,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const WEBHOOK_SECRET = 'whsec_e2e_ttl_sweep_secret_0123456789';
const STOCK = 10;
const QUANTITY = 2;
// Nothing is left to wait for: the suite ages holds by writing `expires_at`, not by sleeping.
const SWEEP_ALL = { graceSec: 0, batchSize: 50 };

// The expiry sweep over real Postgres: proves an order nobody ever settles gives its stock back, that
// it does so without asking the payment gateway anything, and that it can never talk over a
// settlement that got there first.
describe('Reservation TTL sweep (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let sweep: SweepExpiredReservationsUseCase;
  let processor: DomainEventProcessor;
  let sku: SellableSku;

  beforeAll(async () => {
    gateway = new FakeSignerGatewayAdapter(WEBHOOK_SECRET);
    app = await createTestApp({ PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET }, [
      { provide: PAYMENT_GATEWAY, useValue: gateway },
    ]);
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
    sweep = app.get(SweepExpiredReservationsUseCase);
    processor = app.get(DomainEventProcessor);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDatabase(pool);
    sku = await seedSellableSku(app, { onHand: STOCK });
  });

  async function lapse(orderId: string, minutesAgo = 30): Promise<void> {
    await db
      .update(schema.reservations)
      .set({ expiresAt: new Date(Date.now() - minutesAgo * 60_000) })
      .where(eq(schema.reservations.orderId, orderId));
  }

  async function readReservation(orderId: string) {
    const [row] = await db.select().from(schema.reservations).where(eq(schema.reservations.orderId, orderId));
    return row;
  }

  async function lapsedOrder(minutesAgo = 30): Promise<OpenOrder> {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    await lapse(order.orderId, minutesAgo);
    return order;
  }

  /** The event the finalizing transaction actually wrote, as the consumer would receive it. */
  async function expiryJob(orderId: string): Promise<DomainEventJob> {
    const [row] = await db
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.aggregateId, orderId))
      // `created_at` is transaction start time, so rows written together tie; the UUIDv7 id breaks it.
      .orderBy(desc(schema.outbox.createdAt), desc(schema.outbox.id));
    expect(row.eventType).toBe('order.expired');
    return {
      outboxId: row.id,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      eventType: row.eventType,
      payload: row.payload,
      occurredAt: row.createdAt.toISOString(),
      traceparent: null,
    };
  }

  it('expires an order nothing ever settled and gives the stock back', async () => {
    const { orderId } = await lapsedOrder();
    expect((await readStock(app, sku.variantId)).quantityReserved).toBe(QUANTITY);

    const summary = await sweep.execute(SWEEP_ALL);

    expect(summary).toEqual({ scanned: 1, expired: 1, raced: 0, errors: 0 });
    const order = await readOrder(app, orderId);
    expect(order.status).toBe(OrderStatus.EXPIRED);
    expect(order.finalizeReason).toBe('ttl:expired');
    expect((await readReservation(orderId)).status).toBe('RELEASED');
    const stock = await readStock(app, sku.variantId);
    expect(stock.quantityReserved).toBe(0);
    expect(stock.quantityOnHand).toBe(STOCK); // released, not sold
  });

  // The reason this sweep exists next to the gateway-driven one: it still converges when the
  // provider is unreachable, which is precisely when orders pile up.
  it('converges without asking the payment gateway anything', async () => {
    const probe = vi.spyOn(gateway, 'getPaymentStatus');
    const expire = vi.spyOn(gateway, 'expireSession');
    const { orderId } = await lapsedOrder();

    await sweep.execute(SWEEP_ALL);

    expect((await readOrder(app, orderId)).status).toBe(OrderStatus.EXPIRED);
    expect(probe).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
  });

  it('leaves a buyer who is still inside the hold window alone', async () => {
    const { orderId } = await placeAndOpenSession(app, sku, QUANTITY);

    expect(await sweep.execute(SWEEP_ALL)).toEqual({ scanned: 0, expired: 0, raced: 0, errors: 0 });
    expect((await readOrder(app, orderId)).status).toBe(OrderStatus.PENDING);
    expect((await readStock(app, sku.variantId)).quantityReserved).toBe(QUANTITY);
  });

  it('waits out the grace period, so the gateway-driven sweep keeps first refusal', async () => {
    const { orderId } = await lapsedOrder(5);

    expect(await sweep.execute({ graceSec: 15 * 60, batchSize: 50 })).toMatchObject({ scanned: 0 });
    expect((await readOrder(app, orderId)).status).toBe(OrderStatus.PENDING);

    expect(await sweep.execute(SWEEP_ALL)).toMatchObject({ expired: 1 });
    expect((await readOrder(app, orderId)).status).toBe(OrderStatus.EXPIRED);
  });

  it('never sees an order a webhook already settled', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    await postWebhook(app, signOutcome(WEBHOOK_SECRET, order.sessionId, order.charge, 'PAID', 'evt_ttl_paid')).expect(
      200,
    );
    await lapse(order.orderId);

    // Settling committed the hold, so it is not HELD and never enters the work queue at all.
    expect(await sweep.execute(SWEEP_ALL)).toEqual({ scanned: 0, expired: 0, raced: 0, errors: 0 });
    expect((await readOrder(app, order.orderId)).status).toBe(OrderStatus.PAID);
    expect((await readReservation(order.orderId)).status).toBe('COMMITTED');
  });

  // The settlement that commits between the sweep's read and its row lock: the terminal guard, not
  // the read, is what keeps the sweep off it.
  it('cannot talk over a settlement that won the race', async () => {
    const { orderId } = await lapsedOrder();
    await db.update(schema.orders).set({ status: OrderStatus.PAID }).where(eq(schema.orders.id, orderId));

    const summary = await sweep.execute(SWEEP_ALL);

    expect(summary).toEqual({ scanned: 1, expired: 0, raced: 1, errors: 0 });
    expect((await readOrder(app, orderId)).status).toBe(OrderStatus.PAID);
    // Stock stays held rather than being handed back behind a paid order.
    expect((await readReservation(orderId)).status).toBe('HELD');
    expect((await readStock(app, sku.variantId)).quantityReserved).toBe(QUANTITY);
  });

  it('releases the stock exactly once when it runs twice', async () => {
    const { orderId } = await lapsedOrder();

    await sweep.execute(SWEEP_ALL);
    const afterFirst = await readStock(app, sku.variantId);
    expect(await sweep.execute(SWEEP_ALL)).toEqual({ scanned: 0, expired: 0, raced: 0, errors: 0 });

    expect(await readStock(app, sku.variantId)).toMatchObject({
      quantityReserved: afterFirst.quantityReserved,
      quantityOnHand: afterFirst.quantityOnHand,
    });
    expect((await readOrder(app, orderId)).status).toBe(OrderStatus.EXPIRED);
  });

  it('stops at the batch size and picks the rest up on the next tick', async () => {
    const orders = [await lapsedOrder(), await lapsedOrder(), await lapsedOrder()];

    expect(await sweep.execute({ graceSec: 0, batchSize: 2 })).toMatchObject({ scanned: 2, expired: 2 });
    const statuses = await Promise.all(orders.map(async (o) => (await readOrder(app, o.orderId)).status));
    expect(statuses.filter((s) => s === OrderStatus.EXPIRED)).toHaveLength(2);

    expect(await sweep.execute({ graceSec: 0, batchSize: 2 })).toMatchObject({ scanned: 1, expired: 1 });
    for (const { orderId } of orders) {
      expect((await readOrder(app, orderId)).status).toBe(OrderStatus.EXPIRED);
    }
  });

  // `batchSize` caps reservation ROWS, so an order holding several SKUs arrives as several rows and
  // has to collapse to one entry — otherwise finalize is called once per line for the same order.
  it('expires a multi-line order once, from the several holds it left behind', async () => {
    const second = await seedSellableSku(app, { onHand: STOCK });
    const { accessToken } = await createTestUser(app);
    for (const variantId of [sku.variantId, second.variantId]) {
      await request(app.getHttpServer())
        .post('/cart/items')
        .set(authHeader(accessToken))
        .send({ skuId: variantId, quantity: QUANTITY })
        .expect(200);
    }
    const placed = await checkout(app, accessToken).expect(201);
    const orderId = placed.body.id as string;
    await lapse(orderId);

    const summary = await sweep.execute(SWEEP_ALL);

    expect(summary).toEqual({ scanned: 1, expired: 1, raced: 0, errors: 0 });
    expect((await readOrder(app, orderId)).status).toBe(OrderStatus.EXPIRED);
    for (const variantId of [sku.variantId, second.variantId]) {
      expect((await readStock(app, variantId)).quantityReserved).toBe(0);
    }
  });

  // The sweep cannot close a checkout session, so the money side stays open until Payment consumes
  // the expiry. Without this the buyer's hosted page still takes money for stock already released.
  describe('the expiry event Payment consumes', () => {
    it('closes the checkout session and settles the payment EXPIRED', async () => {
      const expire = vi.spyOn(gateway, 'expireSession');
      const { orderId, sessionId } = await lapsedOrder();
      await sweep.execute(SWEEP_ALL);
      expect(expire).not.toHaveBeenCalled(); // the sweep itself never asks

      expect(await processor.process(await expiryJob(orderId))).toBe('processed');

      expect(expire).toHaveBeenCalledWith(sessionId);
      expect((await readPayment(app, orderId)).status).toBe(PaymentStatus.EXPIRED);
    });

    it('fails the consume and writes nothing when the gateway refuses', async () => {
      vi.spyOn(gateway, 'expireSession').mockRejectedValue(new Error('gateway unreachable'));
      const { orderId } = await lapsedOrder();
      await sweep.execute(SWEEP_ALL);

      await expect(processor.process(await expiryJob(orderId))).rejects.toThrow('gateway unreachable');

      expect((await readPayment(app, orderId)).status).toBe(PaymentStatus.PENDING);
      // The inbox claim rolled back too — otherwise the redelivery would find it already consumed.
      expect(await db.select().from(schema.inbox)).toHaveLength(0);
    });

    it('does nothing for an order that never opened a session', async () => {
      const expire = vi.spyOn(gateway, 'expireSession');
      const token = await buyerWithCart(app, sku.variantId, QUANTITY);
      const placed = await checkout(app, token).expect(201);
      const orderId = placed.body.id as string;
      await lapse(orderId);
      await sweep.execute(SWEEP_ALL);

      expect(await processor.process(await expiryJob(orderId))).toBe('processed');

      expect(expire).not.toHaveBeenCalled();
      expect(await readPayment(app, orderId)).toBeUndefined();
    });
  });

  it('finishes the batch after one order fails', async () => {
    const orders = [await lapsedOrder(), await lapsedOrder()];
    const finalize = app.get(FinalizeOrderUseCase);
    const real = finalize.execute.bind(finalize);
    const spy = vi.spyOn(finalize, 'execute');
    spy.mockImplementationOnce(() => Promise.reject(new Error('deadlock detected')));
    spy.mockImplementation(real);

    const summary = await sweep.execute(SWEEP_ALL);

    expect(summary).toMatchObject({ scanned: 2, expired: 1, errors: 1 });
    const statuses = await Promise.all(orders.map(async (o) => (await readOrder(app, o.orderId)).status));
    expect(statuses).toContain(OrderStatus.EXPIRED);
    expect(statuses).toContain(OrderStatus.PENDING);
  });
});
