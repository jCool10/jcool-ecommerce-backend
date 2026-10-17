import type { INestApplication } from '@nestjs/common';
import { isNull } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderStatus } from '../../src/modules/order/domain/order-status';
import { SweepExpiredReservationsUseCase } from '../../src/modules/order/application/use-cases';
import { PaymentStatus } from '../../src/modules/payment/domain/payment-status';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import { OUTBOX_WRITER, type OutboxWriterPort } from '../../src/shared/messaging/outbox/outbox-writer.port';
import { DomainEventProcessor } from '../../src/shared/messaging/queue/domain-event.processor';
import {
  deliverApplied,
  publishedEnvelopes,
  snapshotTransportBeforeEach,
  type PublishedEvent,
} from '../setup/domain-event-transport';
import {
  auditLedgerInvariants,
  lapseReservation,
  placeAndOpenSession,
  postWebhook,
  readOrder,
  readPayment,
  readReservation,
  readStock,
  seedSellableSku,
  signOutcome,
  type OpenOrder,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';

const WEBHOOK_SECRET = 'whsec_e2e_crash_convergence_0123456789';
const STOCK = 10;
const QUANTITY = 2;
const SWEEP_ALL = { graceSec: 0, batchSize: 50 };

/**
 * Each case leaves the database in the state one interruption produces, then runs what a restarted
 * service does unattended and reads the whole ledger back, since one order's row would pass on
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
  let sweep: SweepExpiredReservationsUseCase;
  let writer: OutboxWriterPort;
  let sku: SellableSku;

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
    relay = app.get(OutboxRelay);
    processor = app.get(DomainEventProcessor);
    sweep = app.get(SweepExpiredReservationsUseCase);
    writer = app.get<OutboxWriterPort>(OUTBOX_WRITER);
  });

  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);
  // Or a message left over from the previous test lands on rows that no longer exist.
  snapshotTransportBeforeEach(() => app);

  beforeEach(async () => {
    sku = await seedSellableSku(app, { onHand: STOCK });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const settle = (order: OpenOrder, outcome: 'PAID' | 'FAILED', eventId: string) =>
    postWebhook(app, signOutcome(WEBHOOK_SECRET, order.sessionId, order.charge, outcome, eventId));

  const unpublished = () => db.select().from(schema.outbox).where(isNull(schema.outbox.publishedAt));

  const deliverAll = async (): Promise<string[]> => (await deliverApplied(app)).map(({ result }) => result);

  const redeliver = async (events: PublishedEvent[]): Promise<string[]> => {
    const results: string[] = [];
    for (const { envelope, consumer } of events) results.push(await processor.process(envelope!, consumer));
    return results;
  };

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

  /** The state the interruption above must leave, asserted wherever it sets a case up. */
  async function expectFinalizeWasLost(orderId: string): Promise<void> {
    expect((await readPayment(app, orderId)).status).toBe(PaymentStatus.SUCCEEDED);
    expect((await readOrder(app, orderId)).status).toBe(OrderStatus.PENDING);
    expect((await readReservation(app, orderId)).status).toBe('HELD');
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
    expect((await readReservation(app, order.orderId)).status).toBe('COMMITTED');
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
    const published = await publishedEnvelopes(app);
    expect(published.map(({ envelope }) => envelope?.eventType)).toEqual(
      expect.arrayContaining(['payment.succeeded', 'order.paid']),
    );

    // The exact state a relay killed between the publish and its own commit leaves behind: the
    // messages are on the broker, the rows still read as unsent, so the next tick sends every one again.
    await db.update(schema.outbox).set({ publishedAt: null });
    await expect(relay.runOnce(50)).resolves.toMatchObject({ published: published.length, failed: 0 });

    // Nothing dedups a send, so the republish is a second message per row and only the inbox keeps one effect.
    const republished = await publishedEnvelopes(app);
    const outboxIds = (events: PublishedEvent[]) => events.map(({ envelope }) => envelope?.outboxId).sort();
    expect(outboxIds(republished)).toEqual(outboxIds(published));
    const copies = [...published, ...republished];
    expect((await redeliver(copies)).sort()).toEqual([
      ...Array<string>(published.length).fill('duplicate'),
      ...Array<string>(published.length).fill('processed'),
    ]);
    // The durable half: the same envelope delivered again is claimed by nobody and does nothing.
    expect(await redeliver(copies)).toEqual(Array(published.length * 2).fill('duplicate'));

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
    await lapseReservation(app, order.orderId);
    await sweep.execute(SWEEP_ALL);
    await relay.runOnce(50);
    const expiry = (await publishedEnvelopes(app)).find(({ envelope }) => envelope?.eventType === 'order.expired');
    expect(expiry).toBeDefined();

    // The delivery commits, then the consumer dies before the commit, so the broker hands the same
    // message back. This is the one order event carrying an effect outside the emitting transaction,
    // which makes it the only one a redelivery could actually apply twice.
    await expect(redeliver([expiry!])).resolves.toEqual(['processed']);
    await expect(redeliver([expiry!])).resolves.toEqual(['duplicate']);

    expect(expireSession).toHaveBeenCalledExactlyOnceWith(order.sessionId);
    expect((await readPayment(app, order.orderId)).status).toBe(PaymentStatus.EXPIRED);
    expect(await unpublished()).toHaveLength(0);
    await expectLedgerConverged(1);
  });

  it('converges an order no result ever arrives for', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    await lapseReservation(app, order.orderId);

    await restartAndConverge();

    expect((await readOrder(app, order.orderId)).status).toBe(OrderStatus.EXPIRED);
    expect((await readReservation(app, order.orderId)).status).toBe('RELEASED');
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
    await lapseReservation(app, abandoned.orderId);

    await restartAndConverge();

    expect((await readOrder(app, paid.orderId)).status).toBe(OrderStatus.PAID);
    expect((await readOrder(app, failed.orderId)).status).toBe(OrderStatus.FAILED);
    expect((await readOrder(app, abandoned.orderId)).status).toBe(OrderStatus.EXPIRED);
    // One order sold, and the two that did not gave their units back with nothing left held.
    expect(await readStock(app, sku.variantId)).toMatchObject({
      quantityOnHand: STOCK - QUANTITY,
      quantityReserved: 0,
    });
    expect(await unpublished()).toHaveLength(0);
    await expectLedgerConverged(3);
  });
});
