import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ORDER_REFUNDED_EVENT } from '../../src/modules/order/application/order-outbox.mapper';
import type { DrizzleDB } from '../../src/database';
import * as schema from '../../src/database/schema';
import { authHeader } from '../setup/bearer.helper';
import { relayAuthorizationDirect, sagaHandle } from '../setup/fixtures/checkout-saga.fixture';
import {
  auditLedgerInvariants,
  buyerWithCart,
  checkout,
  driveToPaid,
  readOrder,
  readStock,
  reservationsFor,
  seedSellableSku,
  untilOrderStatus,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { createTestAdminPrincipal, type TestPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetSagasAndDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { type InventoryServiceStub, inventoryServiceStub } from '../setup/inventory-service-stub';
import { E2E_METRICS_TOKEN, scrapeMetrics } from '../setup/metrics.helper';
import { type PaymentServiceStub, paymentServiceStub } from '../setup/payment-service-stub';
import { UNREACHABLE_TEMPORAL_ADDRESS } from '../setup/temporal-server';
import { temporalTaskQueueForCurrentSpec } from '../setup/temporal-task-queue';

const ON_HAND = 5;
const QUANTITY = 2;
const REFUND_WAIT_MS = 3000;
// The engine's start budget, a constant: an unconfirmed start answers within it.
const START_WAIT_MS = 5000;
const SAGA_ENV = {
  SAGA_RETRY_BASE_MS: '100',
  SAGA_RETRY_CAP_MS: '1000',
  REFUND_WAIT_MS: String(REFUND_WAIT_MS),
  REFUND_PENDING_POLL_BASE_MS: '1000',
  REFUND_PENDING_POLL_MAX_MS: '600000',
};
const SETTLE_TIMEOUT_MS = 15_000;

describe('Admin refund (integration, real Temporal dev server, payment and inventory stubs)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let payment: PaymentServiceStub;
  let inventory: InventoryServiceStub;
  let admin: TestPrincipal;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool({ ...SAGA_ENV, METRICS_TOKEN: E2E_METRICS_TOKEN }));
    payment = await paymentServiceStub();
    inventory = await inventoryServiceStub();
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app],
    () => pool,
  );
  beforeEach(async () => {
    admin = await createTestAdminPrincipal(app);
  });

  const refund = (token: string, orderId: string, on: INestApplication = app): request.Test =>
    request(on.getHttpServer()).post(`/admin/orders/${orderId}/refund`).set(authHeader(token));

  async function paidOrder(): Promise<{ orderId: string; sku: SellableSku; buyer: string }> {
    const sku = await seedSellableSku(app, { onHand: ON_HAND });
    const buyer = await buyerWithCart(app, sku.variantId, QUANTITY);
    const orderId = (await checkout(app, buyer).expect(201)).body.id as string;
    await driveToPaid(app, buyer, orderId);
    return { orderId, sku, buyer };
  }

  async function refundedEvents(orderId: string): Promise<Record<string, unknown>[]> {
    const rows = await db
      .select({ payload: schema.outbox.payload })
      .from(schema.outbox)
      .where(and(eq(schema.outbox.aggregateId, orderId), eq(schema.outbox.eventType, ORDER_REFUNDED_EVENT)));
    return rows.map(({ payload }) => payload);
  }

  const holdStatuses = async (orderId: string) => (await reservationsFor(app, orderId)).map(({ status }) => status);

  const expectCleanLedger = async (sku: SellableSku) => {
    const report = await auditLedgerInvariants(app, { [sku.variantId]: ON_HAND });
    expect(report.violations).toEqual([]);
    expect(report.pending).toEqual([]);
  };

  it('refunds the money, then restocks, then records one order.refunded naming the admin', async () => {
    const { orderId, sku } = await paidOrder();
    const refunded = async () =>
      (await scrapeMetrics(app)).value('saga_step_total', { step: 'refund_payment', outcome: 'refunded' }) ?? 0;
    const before = await refunded();

    const res = await refund(admin.accessToken, orderId).expect(200);

    expect(await refunded()).toBe(before + 1);

    expect(res.body).toMatchObject({ id: orderId, status: 'REFUNDED', finalizeReason: 'admin:refund' });
    expect(payment.providerRefunds(orderId)).toBe(1);
    expect(payment.refundRequestersOf(orderId)).toEqual([admin.user.id]);
    expect(await holdStatuses(orderId)).toEqual(['RESTOCKED']);
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: ON_HAND, quantityReserved: 0 });
    const order = await readOrder(app, orderId);
    expect(await refundedEvents(orderId)).toEqual([
      expect.objectContaining({
        orderId,
        userId: order.userId,
        totalAmountMinor: order.totalAmount,
        currency: 'VND',
        requestedBy: admin.user.id,
        reason: 'admin:refund',
      }),
    ]);
    await expectCleanLedger(sku);
  });

  it('answers a repeat 200 without asking either participant again', async () => {
    const { orderId } = await paidOrder();
    await refund(admin.accessToken, orderId).expect(200);
    const before = { refund: payment.calls('refund'), restock: inventory.calls('restock') };

    const again = await refund(admin.accessToken, orderId).expect(200);

    expect(again.body).toMatchObject({ status: 'REFUNDED' });
    expect({ refund: payment.calls('refund'), restock: inventory.calls('restock') }).toEqual(before);
    expect(await refundedEvents(orderId)).toHaveLength(1);
  });

  it('refunds once under ten concurrent calls from two admins, all on the run the first one started', async () => {
    const { orderId, sku } = await paidOrder();
    const other = await createTestAdminPrincipal(app);
    const admins = [admin, other];

    const answers = await Promise.all(
      Array.from({ length: 10 }, (_, n) => refund(admins[n % 2].accessToken, orderId).then(({ status }) => status)),
    );

    expect(answers.filter((status) => status !== 200 && status !== 202)).toEqual([]);
    await untilOrderStatus(app, orderId, 'REFUNDED', SETTLE_TIMEOUT_MS);
    expect(payment.providerRefunds(orderId)).toBe(1);
    expect(inventory.calls('restock')).toBe(1);
    const events = await refundedEvents(orderId);
    expect(events).toHaveLength(1);
    const [{ requestedBy }] = events;
    expect(admins.map(({ user }) => user.id)).toContain(requestedBy);
    expect(new Set(payment.refundRequestersOf(orderId))).toEqual(new Set([requestedBy]));
    await expectCleanLedger(sku);
  });

  it('answers 202 within its wait while Stripe holds the refund, and finishes once Stripe settles it', async () => {
    const { orderId, sku } = await paidOrder();
    payment.stripeRefundPending(orderId);

    const startedAt = Date.now();
    const res = await refund(admin.accessToken, orderId).expect(202);

    expect(Date.now() - startedAt).toBeLessThan(REFUND_WAIT_MS + 1000);
    expect(res.body).toMatchObject({ id: orderId, status: 'REFUNDING' });
    // Money first: nothing goes back on the shelf while the refund is open.
    expect(await holdStatuses(orderId)).toEqual(['COMMITTED']);
    expect((await scrapeMetrics(app)).value('order_refunding_oldest_seconds')).toBeGreaterThan(1);

    payment.settleRefund(orderId);

    await untilOrderStatus(app, orderId, 'REFUNDED', SETTLE_TIMEOUT_MS);
    expect(payment.providerRefunds(orderId)).toBe(1);
    expect(await holdStatuses(orderId)).toEqual(['RESTOCKED']);
    expect((await scrapeMetrics(app)).value('order_refunding_oldest_seconds')).toBe(0);
    await expectCleanLedger(sku);
  });

  it('answers 409 REFUND_FAILED when Stripe fails the refund, the order back at PAID with its stock', async () => {
    const { orderId, sku } = await paidOrder();
    payment.stripeFailsRefund(orderId);

    const res = await refund(admin.accessToken, orderId).expect(409);

    expect(res.body.message).toEqual({ code: 'REFUND_FAILED', reason: 'expired_or_canceled_card' });
    expect((await readOrder(app, orderId)).status).toBe('PAID');
    expect(await holdStatuses(orderId)).toEqual(['COMMITTED']);
    expect(inventory.calls('restock')).toBe(0);
    expect(await refundedEvents(orderId)).toEqual([]);

    // The failed header blocks a second refund at Stripe; the order stays as it was.
    await refund(admin.accessToken, orderId).expect(409);
    expect(payment.providerRefunds(orderId)).toBe(1);
    expect((await readOrder(app, orderId)).status).toBe('PAID');
    await expectCleanLedger(sku);
  });

  it('retries a payment-service that errors twice and still answers within the wait', async () => {
    const { orderId } = await paidOrder();
    payment.fail('refund', 500, { times: 2 });

    await refund(admin.accessToken, orderId).expect(200);

    expect(payment.calls('refund')).toBe(3);
    expect(payment.providerRefunds(orderId)).toBe(1);
  });

  it('answers 202 while Stripe is away, and refunds once after it returns', async () => {
    const { orderId, sku } = await paidOrder();
    payment.providerDown('refund', { times: Infinity });

    const res = await refund(admin.accessToken, orderId).expect(202);

    expect(res.body).toMatchObject({ status: 'REFUNDING' });
    expect(payment.calls('refund')).toBeGreaterThan(1);
    payment.clearFault('refund');
    await untilOrderStatus(app, orderId, 'REFUNDED', SETTLE_TIMEOUT_MS);
    expect(payment.providerRefunds(orderId)).toBe(1);
    await expectCleanLedger(sku);
  });

  it('retries a restock the inventory refuses, counting each conflict, until it is fixed by hand', async () => {
    const { orderId, sku } = await paidOrder();
    const conflicts = async () =>
      (await scrapeMetrics(app)).value('saga_step_total', { step: 'restock', outcome: 'conflict' }) ?? 0;
    const before = await conflicts();
    // A header the saga never leaves a paid order in: restock answers CONFLICT.
    inventory.setHeader(orderId, 'RELEASED');

    await refund(admin.accessToken, orderId).expect(202);

    await expect.poll(conflicts, { timeout: SETTLE_TIMEOUT_MS }).toBeGreaterThanOrEqual(before + 2);
    expect((await readOrder(app, orderId)).status).toBe('REFUNDING');
    expect(payment.providerRefunds(orderId)).toBe(1);

    inventory.setHeader(orderId, 'COMMITTED');
    await untilOrderStatus(app, orderId, 'REFUNDED', SETTLE_TIMEOUT_MS);
    await expectCleanLedger(sku);
  });

  it('completes a payment.authorized redelivered after the refund without voiding anything', async () => {
    const { orderId } = await paidOrder();
    await refund(admin.accessToken, orderId).expect(200);
    const cancels = payment.calls('cancel');

    await relayAuthorizationDirect(app, orderId);

    await expect(sagaHandle(app, orderId).result()).resolves.toBe('COMPLETED');
    expect(payment.calls('cancel')).toBe(cancels);
    expect((await readOrder(app, orderId)).status).toBe('REFUNDED');
  });

  describe('who and what can be refunded', () => {
    it('refuses a buyer with 403', async () => {
      const { orderId, buyer } = await paidOrder();

      await refund(buyer, orderId).expect(403);
      expect(payment.calls('refund')).toBe(0);
    });

    it('answers 404 for an order that does not exist', async () => {
      await refund(admin.accessToken, testId()).expect(404);
    });

    it('refuses a pending and a cancelled order with 409, asking no one', async () => {
      const sku = await seedSellableSku(app, { onHand: ON_HAND });
      const pending = (await checkout(app, await buyerWithCart(app, sku.variantId)).expect(201)).body.id as string;
      const buyer = await buyerWithCart(app, sku.variantId);
      const cancelled = (await checkout(app, buyer).expect(201)).body.id as string;
      await request(app.getHttpServer()).post(`/orders/${cancelled}/cancel`).set(authHeader(buyer)).expect(200);

      for (const orderId of [pending, cancelled]) {
        const res = await refund(admin.accessToken, orderId).expect(409);
        expect(res.body.message).toMatch(/cannot be refunded in status (PENDING|CANCELLED)/);
      }
      expect(payment.calls('refund')).toBe(0);
    });
  });

  describe('Temporal unreachable', () => {
    let deadApp: INestApplication;

    beforeAll(async () => {
      ({ app: deadApp } = await createTestAppWithPool({
        ...SAGA_ENV,
        TEMPORAL_ADDRESS: UNREACHABLE_TEMPORAL_ADDRESS,
        TEMPORAL_TASK_QUEUE: temporalTaskQueueForCurrentSpec('unreachable'),
        TEMPORAL_WORKER_SHUTDOWN_GRACE_MS: '500',
        TEMPORAL_WORKER_SHUTDOWN_FORCE_MS: '500',
      }));
    });
    afterAll(async () => {
      await deadApp?.close();
    });

    it('answers 503 with Retry-After within the start budget, the order still PAID', async () => {
      const { orderId } = await paidOrder();

      const startedAt = Date.now();
      const res = await refund(admin.accessToken, orderId, deadApp);

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(Date.now() - startedAt).toBeLessThan(START_WAIT_MS + 1000);
      expect((await readOrder(app, orderId)).status).toBe('PAID');
      expect(payment.calls('refund')).toBe(0);
    });
  });
});
