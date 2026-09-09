import type { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { eq, isNull } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderStatus } from '../../src/modules/order/domain/order-status';
import { SweepExpiredReservationsUseCase } from '../../src/modules/order/application/use-cases';
import { PAYMENT_GATEWAY } from '../../src/modules/payment/application/ports/payment-gateway.port';
import { PaymentStatus } from '../../src/modules/payment/domain/payment-status';
import { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import { OUTBOX_WRITER, type OutboxWriterPort } from '../../src/shared/messaging/outbox/outbox-writer.port';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';
import { DomainEventProcessor } from '../../src/shared/messaging/queue/domain-event.processor';
import { DOMAIN_EVENTS_QUEUE } from '../../src/shared/messaging/queue/queue.constants';
import {
  auditLedgerInvariants,
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

const WEBHOOK_SECRET = 'whsec_e2e_crash_convergence_0123456789';
const STOCK = 10;
const QUANTITY = 2;
const SWEEP_ALL = { graceSec: 0, batchSize: 50 };

/**
 * Each case leaves the database in the state one interruption produces, then runs what a restarted
 * service does unattended and reads the WHOLE ledger back — asserting one order's row would pass on
 * a state that leaked stock elsewhere. A real SIGKILL mid-transaction is not reproducible in a test,
 * so the interruption is injected at the boundary it would land on.
 */
describe('Saga crash convergence (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let relay: OutboxRelay;
  let processor: DomainEventProcessor;
  let queue: Queue;
  let sweep: SweepExpiredReservationsUseCase;
  let writer: OutboxWriterPort;
  let sku: SellableSku;

  beforeAll(async () => {
    gateway = new FakeSignerGatewayAdapter(WEBHOOK_SECRET);
    app = await createTestApp({ PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET }, [
      { provide: PAYMENT_GATEWAY, useValue: gateway },
    ]);
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
    relay = app.get(OutboxRelay);
    processor = app.get(DomainEventProcessor);
    queue = app.get<Queue>(DOMAIN_EVENTS_QUEUE);
    sweep = app.get(SweepExpiredReservationsUseCase);
    writer = app.get<OutboxWriterPort>(OUTBOX_WRITER);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await queue.obliterate({ force: true });
    sku = await seedSellableSku(app, { onHand: STOCK });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const settle = (order: OpenOrder, outcome: 'PAID' | 'FAILED', eventId: string) =>
    postWebhook(app, signOutcome(WEBHOOK_SECRET, order.sessionId, order.charge, outcome, eventId));

  const unpublished = () => db.select().from(schema.outbox).where(isNull(schema.outbox.publishedAt));

  const queuedJobs = async (): Promise<DomainEventJob[]> => {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);
    return jobs.map((job) => job.data as DomainEventJob);
  };

  const deliverAll = async (): Promise<string[]> => {
    const results: string[] = [];
    for (const job of await queuedJobs()) {
      results.push(await processor.process(job));
    }
    return results;
  };

  async function readReservation(orderId: string) {
    const [row] = await db.select().from(schema.reservations).where(eq(schema.reservations.orderId, orderId));
    return row;
  }

  /** Age a hold past its expiry — the one thing a test cannot wait for. */
  async function lapse(orderId: string): Promise<void> {
    await db
      .update(schema.reservations)
      .set({ expiresAt: new Date(Date.now() - 30 * 60_000) })
      .where(eq(schema.reservations.orderId, orderId));
  }

  // Run twice: settling an order emits its own events, which need a second drain before the ledger
  // is quiet.
  async function restartAndConverge(): Promise<void> {
    for (let pass = 0; pass < 2; pass += 1) {
      await relay.runOnce(50);
      await deliverAll();
      await sweep.execute(SWEEP_ALL);
    }
    await relay.runOnce(50);
    await deliverAll();
  }

  async function expectLedgerConverged(orders: number): Promise<void> {
    expect(await auditLedgerInvariants(app, { [sku.variantId]: STOCK })).toEqual({
      orders,
      pending: [],
      violations: [],
    });
  }

  /** Interrupt the finalizing transaction at its last write, leaving the payment side already committed. */
  function killFinalizeBeforeCommit() {
    const append = writer.append.bind(writer) as OutboxWriterPort['append'];
    return vi.spyOn(writer, 'append').mockImplementation(async (tx, record) => {
      if (record.eventType.startsWith('order.')) throw new Error('killed before the finalize committed');
      await append(tx, record);
    });
  }

  /** The state the interruption above must leave — asserted wherever it sets a case up. */
  async function expectFinalizeWasLost(orderId: string): Promise<void> {
    expect((await readPayment(app, orderId)).status).toBe(PaymentStatus.SUCCEEDED);
    expect((await readOrder(app, orderId)).status).toBe(OrderStatus.PENDING);
    expect((await readReservation(orderId)).status).toBe('HELD');
  }

  it('converges an order whose finalize died inside its own transaction', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    const killed = killFinalizeBeforeCommit();

    await settle(order, 'PAID', 'evt_kill_in_tx').expect(200);
    killed.mockRestore();

    // Money moved and nothing else did: the status flip, the stock commit and the event were one
    // write, so losing the transaction lost all three together rather than half of them.
    await expectFinalizeWasLost(order.orderId);
    expect(await unpublished()).not.toContainEqual(expect.objectContaining({ eventType: 'order.paid' }));

    await restartAndConverge();

    expect((await readOrder(app, order.orderId)).status).toBe(OrderStatus.PAID);
    expect((await readReservation(order.orderId)).status).toBe('COMMITTED');
    expect(await readStock(app, sku.variantId)).toMatchObject({
      quantityOnHand: STOCK - QUANTITY,
      quantityReserved: 0,
    });
    expect(await unpublished()).toHaveLength(0);
    await expectLedgerConverged(1);
  });

  it('converges an order that settled but never got its events published', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    await settle(order, 'PAID', 'evt_kill_before_relay').expect(200);

    // The kill lands after every business transaction committed and before the relay ran once.
    expect((await readOrder(app, order.orderId)).status).toBe(OrderStatus.PAID);
    expect((await unpublished()).map((row) => row.eventType)).toEqual(
      expect.arrayContaining(['order.placed', 'payment.succeeded', 'order.paid']),
    );

    await restartAndConverge();

    expect(await unpublished()).toHaveLength(0);
    expect(await readStock(app, sku.variantId)).toMatchObject({
      quantityOnHand: STOCK - QUANTITY,
      quantityReserved: 0,
    });
    await expectLedgerConverged(1);
  });

  it('moves the stock once when the relay republishes a row it never marked', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    await settle(order, 'PAID', 'evt_kill_after_publish').expect(200);
    await relay.runOnce(50);
    const published = await queuedJobs();
    expect(published.map((job) => job.eventType)).toEqual(expect.arrayContaining(['payment.succeeded', 'order.paid']));

    // The exact state a relay killed between the publish and its own commit leaves behind: the jobs
    // are on the queue, the rows still read as unsent, so the next tick sends every one of them again.
    await db.update(schema.outbox).set({ publishedAt: null });
    await expect(relay.runOnce(50)).resolves.toMatchObject({ published: published.length, failed: 0 });

    // Re-adding under the row id is what keeps a republish from becoming a second job — the cheap
    // half of the defence, and the only one that acts before the effect is ever attempted.
    expect(await queuedJobs()).toHaveLength(published.length);
    expect(await deliverAll()).toEqual(Array(published.length).fill('processed'));
    // The durable half: the same envelope delivered again is claimed by nobody and does nothing.
    expect(await deliverAll()).toEqual(Array(published.length).fill('duplicate'));

    expect(await readStock(app, sku.variantId)).toMatchObject({
      quantityOnHand: STOCK - QUANTITY,
      quantityReserved: 0,
    });
    expect(await unpublished()).toHaveLength(0);
    await expectLedgerConverged(1);
  });

  it('applies the expiry effect once when the worker dies before acknowledging it', async () => {
    const expireSession = vi.spyOn(gateway, 'expireSession');
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    await lapse(order.orderId);
    await sweep.execute(SWEEP_ALL);
    await relay.runOnce(50);
    const [expiry] = (await queuedJobs()).filter((job) => job.eventType === 'order.expired');
    expect(expiry).toBeDefined();

    // The delivery commits, then the worker dies before the ack — so the queue hands the same job
    // back. This is the one order event carrying an effect outside the emitting transaction, which
    // makes it the only one a redelivery could actually apply twice.
    await expect(processor.process(expiry)).resolves.toBe('processed');
    await expect(processor.process(expiry)).resolves.toBe('duplicate');

    expect(expireSession).toHaveBeenCalledExactlyOnceWith(order.sessionId);
    expect((await readPayment(app, order.orderId)).status).toBe(PaymentStatus.EXPIRED);
    expect(await unpublished()).toHaveLength(0);
    await expectLedgerConverged(1);
  });

  it('converges an order no result ever arrives for', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    await lapse(order.orderId);

    await restartAndConverge();

    expect((await readOrder(app, order.orderId)).status).toBe(OrderStatus.EXPIRED);
    expect((await readReservation(order.orderId)).status).toBe('RELEASED');
    // Nothing was sold, so every seeded unit is back on the shelf rather than stranded in a hold.
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: STOCK, quantityReserved: 0 });
    expect((await readPayment(app, order.orderId)).status).toBe(PaymentStatus.EXPIRED);
    expect(await unpublished()).toHaveLength(0);
    await expectLedgerConverged(1);
  });

  it('converges a batch cut at three different points at once', async () => {
    const paid = await placeAndOpenSession(app, sku, QUANTITY);
    const failed = await placeAndOpenSession(app, sku, QUANTITY);
    const abandoned = await placeAndOpenSession(app, sku, QUANTITY);

    const killed = killFinalizeBeforeCommit();
    await settle(paid, 'PAID', 'evt_batch_paid').expect(200);
    killed.mockRestore();
    // Pinned here, not only in the single-order case: without it a kill that stops biting turns this
    // into three ordinary orders converging, and every assertion below still passes.
    await expectFinalizeWasLost(paid.orderId);
    await settle(failed, 'FAILED', 'evt_batch_failed').expect(200);
    await lapse(abandoned.orderId);

    await restartAndConverge();

    expect((await readOrder(app, paid.orderId)).status).toBe(OrderStatus.PAID);
    expect((await readOrder(app, failed.orderId)).status).toBe(OrderStatus.FAILED);
    expect((await readOrder(app, abandoned.orderId)).status).toBe(OrderStatus.EXPIRED);
    // One order sold, two gave their units back — and the two that did not sell left nothing held.
    expect(await readStock(app, sku.variantId)).toMatchObject({
      quantityOnHand: STOCK - QUANTITY,
      quantityReserved: 0,
    });
    expect(await unpublished()).toHaveLength(0);
    await expectLedgerConverged(3);
  });
});
