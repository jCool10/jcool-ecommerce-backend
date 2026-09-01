import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PG_POOL } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { PAYMENT_GATEWAY } from '../../src/modules/payment/application/ports/payment-gateway.port';
import { ReconcileStaleOrdersUseCase } from '../../src/modules/payment/application/use-cases';
import { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import {
  auditM2Invariants,
  buyerWithCart,
  checkout,
  openSession,
  placeAndOpenSession,
  postWebhook,
  readOrder,
  readPayment,
  readStock,
  seedSellableSku,
  signOutcome,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import type { SessionCharge } from '../setup/sign-webhook.helper';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const WEBHOOK_SECRET = 'whsec_e2e_m2_acceptance_0123456789';
// Sweep on sight: the suite decides staleness by what it stages, never by waiting on a clock.
const SWEEP_ALL = { staleAfterSec: 0, ttlSec: 900, batchSize: 50 };
const PRICE_MINOR = 150_000;

// Contended checkout needs more callers than the pg pool (10) so the race is decided in Postgres.
const CONTENDERS = 12;
const UNITS = 4;

// The milestone gate for order→pay: the per-behaviour suites each prove one guard, this one runs the
// paths together and then reads the whole ledger back — money, stock, and status must agree on every
// row, with no order left waiting.
describe('M2 acceptance: order → pay → settle (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let gateway: FakeSignerGatewayAdapter;
  let reconcile: ReconcileStaleOrdersUseCase;

  beforeAll(async () => {
    // The payment provider is the only test double: the boundary outside the system. Signature
    // verification, dedup, finalize, and stock resolution are all the real code under test.
    gateway = new FakeSignerGatewayAdapter(WEBHOOK_SECRET);
    app = await createTestApp(
      {
        PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET,
        RECONCILE_ENABLED: 'false',
        // Pinned, not inherited: the exact-UNITS assertion below holds only under a strategy that makes
        // losers wait. Optimistic gives up after `INVENTORY_OPTIMISTIC_MAX_RETRIES` (3) CAS misses, so a
        // contender could 409 with a unit still unsold once UNITS exceeds that budget.
        INVENTORY_LOCK_STRATEGY: 'pessimistic',
      },
      [{ provide: PAYMENT_GATEWAY, useValue: gateway }],
    );
    pool = app.get<Pool>(PG_POOL);
    reconcile = app.get(ReconcileStaleOrdersUseCase);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  const paid = (sessionId: string, charge: SessionCharge, eventId: string) =>
    signOutcome(WEBHOOK_SECRET, sessionId, charge, 'PAID', eventId);
  const failed = (sessionId: string, eventId: string) =>
    signOutcome(WEBHOOK_SECRET, sessionId, { amountMinor: null, currency: null }, 'FAILED', eventId);

  // `expectedOrders` is not decoration: without it an audit that found nothing to check reads exactly
  // like an audit that found everything in order.
  async function expectLedgerConsistent(sku: SellableSku, expectedOrders: number): Promise<void> {
    const audit = await auditM2Invariants(app, { [sku.variantId]: sku.onHand });
    expect(audit.violations).toEqual([]);
    expect(audit.pending).toEqual([]);
    expect(audit.orders).toBe(expectedOrders);
  }

  it('settles money, stock, and status together on the happy path', async () => {
    const sku = await seedSellableSku(app, { onHand: 5, priceMinor: PRICE_MINOR });
    // Three units on one line: quantity, not row count, is what the ledger has to reconcile.
    const order = await placeAndOpenSession(app, sku, 3);

    const res = await postWebhook(app, paid(order.sessionId, order.charge, 'evt_m2_happy'));

    expect(res.status).toBe(200);
    expect((await readOrder(app, order.orderId)).status).toBe('PAID');
    const payment = await readPayment(app, order.orderId);
    expect(payment.status).toBe('SUCCEEDED');
    expect(payment.amountMinor).toBe(PRICE_MINOR * 3); // charged the order snapshot, not the live price
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: 2, quantityReserved: 0 });
    await expectLedgerConsistent(sku, 1);
  });

  it('lets exactly as many buyers pay as there are units, however many race for them', async () => {
    const sku = await seedSellableSku(app, { onHand: UNITS, priceMinor: PRICE_MINOR });
    const tokens = await Promise.all(Array.from({ length: CONTENDERS }, () => buyerWithCart(app, sku.variantId)));

    const settled = await Promise.allSettled(tokens.map((token) => checkout(app, token)));
    const won = settled.flatMap((r, i) =>
      r.status === 'fulfilled' && r.value.status === 201
        ? [{ token: tokens[i], orderId: r.value.body.id as string }]
        : [],
    );

    expect(won).toHaveLength(UNITS);
    expect(settled.filter((r) => r.status === 'fulfilled' && r.value.status === 409)).toHaveLength(CONTENDERS - UNITS);

    // Every winner walks the rest of the pipeline — the losers never got an order to pay for.
    for (const [i, winner] of won.entries()) {
      const pay = await openSession(app, winner.token, winner.orderId).expect(201);
      const recorded = await readPayment(app, winner.orderId);
      const charge: SessionCharge = { amountMinor: recorded.amountMinor, currency: recorded.currency };
      await postWebhook(app, paid(pay.body.providerSessionId as string, charge, `evt_m2_race_${i}`)).expect(200);
      expect((await readOrder(app, winner.orderId)).status).toBe('PAID');
    }

    // The shelf is empty and nothing is held: sold exactly the units that existed, never one more.
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: 0, quantityReserved: 0 });
    await expectLedgerConsistent(sku, UNITS);
  });

  it('charges once when a delivery repeats and a sweep passes over the same order', async () => {
    const sku = await seedSellableSku(app, { onHand: 5, priceMinor: PRICE_MINOR });
    const order = await placeAndOpenSession(app, sku);
    const delivery = paid(order.sessionId, order.charge, 'evt_m2_dup');
    gateway.setPaymentStatus(order.sessionId, 'PAID');

    const first = await postWebhook(app, delivery);
    const second = await postWebhook(app, delivery);
    const summary = await reconcile.execute(SWEEP_ALL);

    expect([first.body.status, second.body.status].sort()).toEqual(['duplicate', 'processed']);
    // The order stopped being PENDING when the first delivery landed, so the sweep never queues it.
    expect(summary).toMatchObject({ scanned: 0, finalized: 0, errors: 0 });
    expect((await readOrder(app, order.orderId)).status).toBe('PAID');
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: 4, quantityReserved: 0 });
    await expectLedgerConsistent(sku, 1);
  });

  it('converges an order whose webhook never arrived', async () => {
    const sku = await seedSellableSku(app, { onHand: 5, priceMinor: PRICE_MINOR });
    const order = await placeAndOpenSession(app, sku);
    gateway.setPaymentStatus(order.sessionId, 'PAID', 'pi_lost_delivery');

    const summary = await reconcile.execute(SWEEP_ALL);

    expect(summary).toMatchObject({ scanned: 1, finalized: 1, errors: 0 });
    const settledOrder = await readOrder(app, order.orderId);
    expect(settledOrder.status).toBe('PAID');
    expect(settledOrder.finalizeReason).toBe('reconcile:paid');
    expect((await readPayment(app, order.orderId)).status).toBe('SUCCEEDED');
    await expectLedgerConsistent(sku, 1);
  });

  it('holds the line when a failure arrives after the money did', async () => {
    const sku = await seedSellableSku(app, { onHand: 5, priceMinor: PRICE_MINOR });
    const order = await placeAndOpenSession(app, sku);
    await postWebhook(app, paid(order.sessionId, order.charge, 'evt_m2_first')).expect(200);

    const late = await postWebhook(app, failed(order.sessionId, 'evt_m2_late'));

    expect(late.status).toBe(200);
    expect(late.body).toEqual({ status: 'skipped' }); // refused at the payment state machine, before finalize
    expect((await readOrder(app, order.orderId)).status).toBe('PAID');
    expect((await readPayment(app, order.orderId)).status).toBe('SUCCEEDED');
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: 4, quantityReserved: 0 });
    await expectLedgerConsistent(sku, 1);
  });

  it('produces one effect when a webhook and a sweep reach the same order at once', async () => {
    const sku = await seedSellableSku(app, { onHand: 5, priceMinor: PRICE_MINOR });
    const order = await placeAndOpenSession(app, sku);
    gateway.setPaymentStatus(order.sessionId, 'PAID', 'pi_m2_race');

    // Whichever wins the row lock, the other must find the order already terminal and stand down.
    const [webhook] = await Promise.all([
      postWebhook(app, paid(order.sessionId, order.charge, 'evt_m2_sweep_race')),
      reconcile.execute(SWEEP_ALL),
    ]);

    expect(webhook.status).toBe(200);
    expect((await readOrder(app, order.orderId)).status).toBe('PAID');
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: 4, quantityReserved: 0 });
    await expectLedgerConsistent(sku, 1);
  });

  it('leaves a mixed batch of outcomes in a consistent ledger with nothing still pending', async () => {
    const sku = await seedSellableSku(app, { onHand: 10, priceMinor: PRICE_MINOR });
    const [byWebhookPaid, byWebhookFailed, undecided, bySweepPaid] = [
      await placeAndOpenSession(app, sku),
      await placeAndOpenSession(app, sku),
      await placeAndOpenSession(app, sku),
      await placeAndOpenSession(app, sku),
    ];
    // A buyer who abandoned checkout before ever opening a payment session.
    const abandonedToken = await buyerWithCart(app, sku.variantId);
    const abandoned = ((await checkout(app, abandonedToken).expect(201)).body as { id: string }).id;

    await postWebhook(app, paid(byWebhookPaid.sessionId, byWebhookPaid.charge, 'evt_m2_mix_paid')).expect(200);
    await postWebhook(app, failed(byWebhookFailed.sessionId, 'evt_m2_mix_failed')).expect(200);
    gateway.setPaymentStatus(undecided.sessionId, 'PENDING');
    gateway.setPaymentStatus(bySweepPaid.sessionId, 'PAID', 'pi_m2_mix');

    // Past TTL: a definite PAID from the gateway still settles, everything undecided expires.
    const summary = await reconcile.execute({ ...SWEEP_ALL, ttlSec: 0 });

    expect(summary).toMatchObject({ scanned: 3, finalized: 3, errors: 0, unresolved: 0 });
    expect((await readOrder(app, byWebhookPaid.orderId)).status).toBe('PAID');
    expect((await readOrder(app, bySweepPaid.orderId)).status).toBe('PAID');
    expect((await readOrder(app, byWebhookFailed.orderId)).status).toBe('FAILED');
    expect((await readOrder(app, undecided.orderId)).status).toBe('EXPIRED');
    expect((await readOrder(app, abandoned)).status).toBe('EXPIRED');
    // Two sales committed, three holds handed back — the shelf reconciles to the seed.
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: 8, quantityReserved: 0 });
    await expectLedgerConsistent(sku, 5);
  });
});
