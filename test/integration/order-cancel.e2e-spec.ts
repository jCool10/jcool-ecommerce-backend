import type { INestApplication } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderStatus } from '../../src/modules/order/domain/order-status';
import { PAYMENT_GATEWAY } from '../../src/modules/payment/application/ports/payment-gateway.port';
import { HandlePaymentWebhookUseCase } from '../../src/modules/payment/application/use-cases';
import { PaymentStatus } from '../../src/modules/payment/domain/payment-status';
import { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';
import { DomainEventProcessor } from '../../src/shared/messaging/queue/domain-event.processor';
import { METRICS, type MetricsPort } from '../../src/shared/observability/metrics/metrics.port';
import { authHeader } from '../setup/auth.helper';
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
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const WEBHOOK_SECRET = 'whsec_e2e_order_cancel_secret_01234';
const STOCK = 10;
const QUANTITY = 2;
const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

/**
 * The order half settles synchronously under a row lock; the money half rides the outbox to Payment.
 * The interesting cases are all in that gap — a buyer paying on the hosted page after pressing
 * cancel, and a consume that closes the session and then rolls back.
 */
describe('Order cancel (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let processor: DomainEventProcessor;
  let refundOwed: ReturnType<typeof vi.spyOn>;
  let sku: SellableSku;

  beforeAll(async () => {
    gateway = new FakeSignerGatewayAdapter(WEBHOOK_SECRET);
    app = await createTestApp({ PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET }, [
      { provide: PAYMENT_GATEWAY, useValue: gateway },
    ]);
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
    processor = app.get(DomainEventProcessor);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDatabase(pool);
    // Spied rather than read off /metrics: a Prometheus counter is process-wide and shared with
    // every other suite in this worker, so only a per-test spy can assert "exactly once".
    refundOwed = vi.spyOn(app.get<MetricsPort>(METRICS), 'recordRefundOwed');
    sku = await seedSellableSku(app, { onHand: STOCK });
  });

  const server = () => app.getHttpServer();

  function cancel(token: string, orderId: string): request.Test {
    return request(server()).post(`/orders/${orderId}/cancel`).set(authHeader(token));
  }

  /** The event the cancelling transaction actually wrote, as the consumer would receive it. */
  async function cancelledJob(orderId: string): Promise<DomainEventJob> {
    const [row] = await db
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.aggregateId, orderId))
      // The UUIDv7 id breaks the tie: `created_at` is transaction start time, not statement time.
      .orderBy(desc(schema.outbox.createdAt), desc(schema.outbox.id));
    expect(row.eventType).toBe('order.cancelled');
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

  describe('POST /orders/:id/cancel', () => {
    it('cancels a pending order and gives the stock back in the same transaction', async () => {
      const token = await buyerWithCart(app, sku.variantId, QUANTITY);
      const placed = await checkout(app, token).expect(201);
      const orderId = placed.body.id as string;
      expect((await readStock(app, sku.variantId)).quantityReserved).toBe(QUANTITY);

      const res = await cancel(token, orderId).expect(200);

      expect(res.body).toMatchObject({ id: orderId, status: OrderStatus.CANCELLED });
      const order = await readOrder(app, orderId);
      expect(order.status).toBe(OrderStatus.CANCELLED);
      expect(order.finalizeReason).toBe('user:cancel');
      const stock = await readStock(app, sku.variantId);
      expect(stock.quantityReserved).toBe(0);
      expect(stock.quantityOnHand).toBe(STOCK); // released, not sold
    });

    // A client that lost the first response must be able to retry without being told it did
    // something wrong. Nothing about the order moves the second time.
    it('answers a repeated cancel the same way, releasing the stock only once', async () => {
      const token = await buyerWithCart(app, sku.variantId, QUANTITY);
      const orderId = (await checkout(app, token).expect(201)).body.id as string;
      await cancel(token, orderId).expect(200);
      const afterFirst = await readStock(app, sku.variantId);

      await cancel(token, orderId).expect(200);

      expect(await readStock(app, sku.variantId)).toMatchObject({
        quantityOnHand: afterFirst.quantityOnHand,
        quantityReserved: afterFirst.quantityReserved,
      });
      // One settlement, so one event: a second would drive Payment's session close twice.
      const events = await db.select().from(schema.outbox).where(eq(schema.outbox.aggregateId, orderId));
      expect(events.filter((e) => e.eventType === 'order.cancelled')).toHaveLength(1);
    });

    it('refuses to cancel an order the buyer has already paid for', async () => {
      const order = await placeAndOpenSession(app, sku, QUANTITY);
      await postWebhook(
        app,
        signOutcome(WEBHOOK_SECRET, order.sessionId, order.charge, 'PAID', 'evt_cancel_paid'),
      ).expect(200);

      // 409, not 200: unwinding a payment is a refund, which this shop does not do.
      await cancel(order.token, order.orderId).expect(409);
      expect((await readOrder(app, order.orderId)).status).toBe(OrderStatus.PAID);
    });

    // 404 rather than 403, so the endpoint cannot be used to discover which order ids are real.
    it("hides someone else's order behind the same 404 as an id that does not exist", async () => {
      const token = await buyerWithCart(app, sku.variantId, QUANTITY);
      const orderId = (await checkout(app, token).expect(201)).body.id as string;
      const { accessToken: stranger } = await createTestUser(app);

      await cancel(stranger, orderId).expect(404);
      await cancel(stranger, ABSENT_UUID).expect(404);

      expect((await readOrder(app, orderId)).status).toBe(OrderStatus.PENDING);
    });

    it('rejects an unauthenticated cancel with 401', async () => {
      await request(server()).post(`/orders/${ABSENT_UUID}/cancel`).expect(401);
    });
  });

  // The money half. Cancelling deliberately does not reach the gateway under an order row lock, so
  // until this event is consumed the buyer's hosted page can still take money for released stock.
  describe('the cancellation event Payment consumes', () => {
    async function cancelledOrderWithSession(): Promise<{ orderId: string; sessionId: string }> {
      const order = await placeAndOpenSession(app, sku, QUANTITY);
      await cancel(order.token, order.orderId).expect(200);
      return { orderId: order.orderId, sessionId: order.sessionId };
    }

    it('closes the checkout session and settles the payment EXPIRED', async () => {
      const expire = vi.spyOn(gateway, 'expireSession');
      const { orderId, sessionId } = await cancelledOrderWithSession();
      expect(expire).not.toHaveBeenCalled(); // the cancel itself never asks

      expect(await processor.process(await cancelledJob(orderId))).toBe('processed');

      expect(expire).toHaveBeenCalledWith(sessionId);
      expect((await readPayment(app, orderId)).status).toBe(PaymentStatus.EXPIRED);
      expect(refundOwed).not.toHaveBeenCalled();
    });

    // The whole reason this rides the queue: retry until the gateway answers. A failed consume must
    // leave the payment untouched, so the redelivery closes the session for real.
    it('fails the consume and writes nothing when the gateway is unreachable', async () => {
      vi.spyOn(gateway, 'expireSession').mockRejectedValue(new Error('gateway unreachable'));
      const { orderId } = await cancelledOrderWithSession();

      await expect(processor.process(await cancelledJob(orderId))).rejects.toThrow('gateway unreachable');

      expect((await readPayment(app, orderId)).status).toBe(PaymentStatus.PENDING);
      // The inbox claim rolled back with it — otherwise the redelivery would find it consumed.
      expect(await db.select().from(schema.inbox)).toHaveLength(0);
    });

    // The effect commits alongside the inbox claim, so the second attempt is a no-op — and an
    // already-closed session is NOT a refund alarm.
    it('settles exactly once under redelivery, raising nothing on the second pass', async () => {
      const { orderId } = await cancelledOrderWithSession();
      const job = await cancelledJob(orderId);

      expect(await processor.process(job)).toBe('processed');
      expect(await processor.process(job)).toBe('duplicate');

      expect((await readPayment(app, orderId)).status).toBe(PaymentStatus.EXPIRED);
      expect(refundOwed).not.toHaveBeenCalled();
    });

    // The redelivery that follows a consume which closed the session and then rolled back: the
    // gateway reports the session already closed, which is exactly what this needed.
    it('finishes the write on a redelivery whose session an earlier attempt already closed', async () => {
      const { orderId, sessionId } = await cancelledOrderWithSession();
      const job = await cancelledJob(orderId);
      // Close it out of band, then let the consume run for the first time: the same position a
      // rolled-back attempt leaves behind.
      expect(await gateway.expireSession(sessionId)).toBe('expired');

      expect(await processor.process(job)).toBe('processed');

      expect((await readPayment(app, orderId)).status).toBe(PaymentStatus.EXPIRED);
      expect(refundOwed).not.toHaveBeenCalled();
    });
  });

  // The race the cancel button makes routine: the buyer presses cancel with the hosted page still
  // open in another tab, and pays on it. Stock is already released; the money is not.
  describe('cancel racing a payment that has already gone through', () => {
    it('raises the refund decision once and acknowledges the job, rather than retrying it', async () => {
      const order = await placeAndOpenSession(app, sku, QUANTITY);
      await cancel(order.token, order.orderId).expect(200);
      // The gateway took the money after the order died, and the webhook has not arrived yet.
      gateway.setPaymentStatus(order.sessionId, 'PAID');

      // Acknowledged, not retried: no redelivery un-pays a session, so this never reaches the DLQ.
      expect(await processor.process(await cancelledJob(order.orderId))).toBe('processed');

      expect(refundOwed).toHaveBeenCalledExactlyOnceWith('expire_session');
      // Nothing written: recording EXPIRED here would log a settlement that never happened.
      expect((await readPayment(app, order.orderId)).status).toBe(PaymentStatus.PENDING);
      expect(gateway.wasExpired(order.sessionId)).toBe(false);
    });

    // The same money arriving by its own route: the webhook settles the payment, then finds the
    // order already terminal — a second observation of one stranded payment, hence the source label.
    it('raises it again, under a different source, when the webhook lands on the cancelled order', async () => {
      const order = await placeAndOpenSession(app, sku, QUANTITY);
      await cancel(order.token, order.orderId).expect(200);

      await postWebhook(
        app,
        signOutcome(WEBHOOK_SECRET, order.sessionId, order.charge, 'PAID', 'evt_cancel_race'),
      ).expect(200);

      expect(refundOwed).toHaveBeenCalledWith('webhook_direct');
      // The order does not move: the terminal guard is what keeps a cancelled order cancelled.
      expect((await readOrder(app, order.orderId)).status).toBe(OrderStatus.CANCELLED);
      expect((await readPayment(app, order.orderId)).status).toBe(PaymentStatus.SUCCEEDED);
      // And the stock stays released — the buyer is owed money, not the last unit.
      expect((await readStock(app, sku.variantId)).quantityReserved).toBe(0);
    });

    // The durable half of the same webhook. It re-runs the same finalize through the queue, lands on
    // the same terminal order, and is counted under its own source.
    it('raises it from the settlement event too, so a lost webhook still alarms', async () => {
      const order = await placeAndOpenSession(app, sku, QUANTITY);
      await cancel(order.token, order.orderId).expect(200);
      const webhook = app.get(HandlePaymentWebhookUseCase);
      const signed = signOutcome(WEBHOOK_SECRET, order.sessionId, order.charge, 'PAID', 'evt_cancel_event');
      await webhook.execute(Buffer.from(signed.rawBody), signed.headers);

      const [settlement] = await db
        .select()
        .from(schema.outbox)
        .where(eq(schema.outbox.eventType, 'payment.succeeded'))
        .orderBy(desc(schema.outbox.createdAt), desc(schema.outbox.id));

      expect(
        await processor.process({
          outboxId: settlement.id,
          aggregateType: settlement.aggregateType,
          aggregateId: settlement.aggregateId,
          eventType: settlement.eventType,
          payload: settlement.payload,
          occurredAt: settlement.createdAt.toISOString(),
          traceparent: null,
        }),
      ).toBe('processed');

      expect(refundOwed).toHaveBeenCalledWith('settlement_event');
      expect((await readOrder(app, order.orderId)).status).toBe(OrderStatus.CANCELLED);
    });
  });
});
