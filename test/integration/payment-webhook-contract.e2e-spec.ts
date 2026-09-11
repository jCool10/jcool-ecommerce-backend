import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderStatus } from '../../src/modules/order/domain/order-status';
import { PAYMENT_GATEWAY } from '../../src/modules/payment/application/ports/payment-gateway.port';
import {
  PAYMENT_REPOSITORY,
  type PaymentRepositoryPort,
} from '../../src/modules/payment/application/ports/payment-repository.port';
import { ReconcileStaleOrdersUseCase } from '../../src/modules/payment/application/use-cases/reconcile-stale-orders.use-case';
import { PaymentStatus } from '../../src/modules/payment/domain/payment-status';
import { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { signStripeStyle } from '../../src/modules/payment/infrastructure/gateway/hmac-signature';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import {
  buyerWithCart,
  checkout,
  openSession,
  placeAndOpenSession,
  postWebhook,
  readOrder,
  readPayment,
  seedSellableSku,
  signOutcome,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { waitUntilBlockedOnLock } from '../setup/fixtures/inventory.fixture';
import { resetDatabase } from '../setup/reset-database';
import { checkoutSessionCompleted, signWebhook, type SessionCharge } from '../setup/sign-webhook.helper';
import { createTestApp } from '../setup/test-app.factory';

const WEBHOOK_SECRET = 'whsec_e2e_webhook_contract_0123456789';
const STOCK = 10;
const RECONCILE_ALL = { staleAfterSec: 0, ttlSec: 3_600, batchSize: 50 };

const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

/** A genuine signature over arbitrary bytes — the shapes only an authentic sender can produce. */
function signRaw(rawBody: string): { rawBody: string; headers: Record<string, string> } {
  const ts = Math.floor(Date.now() / 1000);
  return {
    rawBody,
    headers: {
      [STRIPE_SIGNATURE_HEADER]: signStripeStyle(WEBHOOK_SECRET, ts, rawBody),
      'content-type': 'application/json',
    },
  };
}

/**
 * The webhook endpoint's contract with the gateway, in the four places the happy path never reaches:
 * an authentic sender whose body we cannot read, an event that arrives before the row it names, an
 * event type the mapper has never heard of, and two different events racing for one payment.
 */
describe('Payment webhook contract at the edges (integration, real Postgres, real HMAC)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let payments: PaymentRepositoryPort;
  let reconcile: ReconcileStaleOrdersUseCase;
  let sku: SellableSku;

  beforeAll(async () => {
    gateway = new FakeSignerGatewayAdapter(WEBHOOK_SECRET);
    app = await createTestApp({ PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET }, [
      { provide: PAYMENT_GATEWAY, useValue: gateway },
    ]);
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
    payments = app.get<PaymentRepositoryPort>(PAYMENT_REPOSITORY);
    reconcile = app.get(ReconcileStaleOrdersUseCase);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    sku = await seedSellableSku(app, { onHand: STOCK });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const webhookRows = () => db.select().from(schema.webhookEvents);
  const webhookRow = async (providerEventId: string) =>
    (await db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.providerEventId, providerEventId)))[0];

  const post = (signed: { rawBody: string; headers: Record<string, string> }) =>
    request(app.getHttpServer()).post('/webhooks/payment').set(signed.headers).send(signed.rawBody);

  // CHARACTERIZATION — pins today's behaviour, which is NOT the intended one.
  //
  // Intended invariant: a request whose signature proves it came from the gateway gets a deliberate
  //   answer, and the anomaly is recorded somewhere a human will find it.
  // Violated at: src/modules/payment/infrastructure/gateway/hmac-signature.ts:91-95 — after the
  //   signature verifies, `JSON.parse` runs unguarded and the id/type check `throw`s a bare Error.
  //   Both escape ProcessWebhookEventUseCase.execute BEFORE its transaction opens
  //   (process-webhook-event.use-case.ts:54-58), so the response is an unmapped 500 and no
  //   `webhook_events` row is ever written — the one delivery that proves the integration is
  //   misconfigured leaves no trace but a log line, and 5xx is exactly what makes Stripe retry it.
  // Follow-up: plans/260910-1940-edge-case-invariant-fixes/plan.md — WH-1 (and matrix q3, the
  //   product choice this pins rather than settles: 400 + an audit row keeps the gateway retrying a
  //   body that will never parse, 200 + a SKIPPED row burns the event id but stops the retries).
  it('500s an authentic delivery whose body it cannot read, and records nothing about it', async () => {
    // JSON, correctly signed, with no string `id` — a shape only an authentic sender produces.
    await post(signRaw(JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } }))).expect(500);

    // Same for a numeric id, which is the shape a schema change would actually take.
    await post(signRaw(JSON.stringify({ id: 42, type: 'checkout.session.completed' }))).expect(500);

    // A JSON array — accepted by the strict parser, no `id` to find, so it lands on the same throw.
    await post(signRaw(JSON.stringify([{ type: 'checkout.session.completed' }]))).expect(500);

    expect(await webhookRows()).toHaveLength(0);
  });

  // The neighbouring edge, and the reason the case above is narrower than it looks: a body that is
  // not JSON never reaches the verifier at all. Express's strict parser rejects it on `content-type`,
  // which is what Stripe always sends — so the unhandled `JSON.parse` at hmac-signature.ts:91 is
  // reachable only for JSON whose SHAPE is wrong, not for bytes that do not parse.
  it('refuses an unparseable body at the edge, before the signature is ever checked', async () => {
    await post(signRaw('<html>502 Bad Gateway</html>')).expect(400);
    // A bare JSON scalar is refused there too — `strict` accepts only objects and arrays.
    await post(signRaw(JSON.stringify('checkout.session.completed'))).expect(400);
  });

  // CHARACTERIZATION — pins today's behaviour, which is NOT the intended one.
  //
  // Intended invariant: a delivery that carries a valid signature is recorded before it is judged,
  //   so an authentic sender we could not read is visible afterwards rather than silently dropped.
  // Violated at: src/shared/security/hmac-signature.ts:91-95 — the body is parsed before anything is
  //   written, so both refusal paths (the 400 from Express's strict parser above, and the 500 from
  //   the unhandled `JSON.parse` on a well-formed body of the wrong shape) return without touching
  //   `webhook_events`. The signature is never consulted on the 400 path, so the request cannot be
  //   distinguished from noise — which is the argument for recording it, not against.
  // Follow-up: plans/260910-1940-edge-case-invariant-fixes/plan.md — WH-1.
  it('records nothing for a delivery it could not read, so an authentic sender leaves no trace', async () => {
    await post(signRaw('<html>502 Bad Gateway</html>')).expect(400);
    await post(signRaw(JSON.stringify('checkout.session.completed'))).expect(400);

    expect(await webhookRows()).toHaveLength(0);
  });

  // CHARACTERIZATION — pins today's behaviour, which is NOT the intended one.
  //
  // Intended invariant: a settling event is applied to the payment it names, whenever it arrives.
  // Violated at: src/modules/payment/application/use-cases/process-webhook-event.use-case.ts:87-92 —
  //   a webhook that overtakes our own INSERT reads no payment and is marked SKIPPED, and the
  //   `webhook_events` unique index then makes the gateway's redelivery a `duplicate` that re-reads
  //   nothing. The event is burnt: the money is settled at the gateway and PENDING here, and the only
  //   remaining path is the reconcile poll, which by default will not look at the order for
  //   ORDER_STALE_THRESHOLD_SEC (configuration.ts:172, 120s) — long after the gateway's own retry.
  // Follow-up: plans/260910-1940-edge-case-invariant-fixes/plan.md — WH-2.
  it('burns a settling event that overtakes the payment insert, leaving reconcile as the only way out', async () => {
    const token = await buyerWithCart(app, sku.variantId, 1);
    const placed = await checkout(app, token).expect(201);
    const orderId = placed.body.id as string;

    // The real race: the gateway has issued the session and fired its webhook while our INSERT is
    // still in flight. Injected at the insert itself, which is the only place that ordering exists.
    let overtaking: { rawBody: string; headers: Record<string, string> } | undefined;
    const create = payments.create.bind(payments);
    vi.spyOn(payments, 'create').mockImplementation(async (payment, tx) => {
      overtaking = signWebhook({
        secret: WEBHOOK_SECRET,
        event: checkoutSessionCompleted(
          payment.providerSessionId,
          { amountMinor: payment.amountMinor, currency: payment.currency },
          { eventId: 'evt_overtakes_insert', paymentIntent: 'pi_overtake' },
        ),
      });
      await post(overtaking).expect(200);
      return create(payment, tx);
    });

    const pay = await openSession(app, token, orderId).expect(201);
    const sessionId = pay.body.providerSessionId as string;
    vi.restoreAllMocks();

    // The row is committed now, but the event that would have settled it is already spent.
    expect(await webhookRow('evt_overtakes_insert')).toMatchObject({ status: 'SKIPPED' });
    expect((await readPayment(app, orderId)).status).toBe(PaymentStatus.PENDING);

    // The gateway's retry is byte-identical, so the unique index answers it before anything re-reads
    // the payment: a deliberate no-op that cannot recover the delivery it deduplicates.
    const retry = await post(overtaking!).expect(200);
    expect(retry.body).toEqual({ status: 'duplicate' });
    expect((await readPayment(app, orderId)).status).toBe(PaymentStatus.PENDING);
    expect(await webhookRows()).toHaveLength(1);

    // Convergence comes only from asking the gateway again — a poll, not the notification we already
    // had in hand and threw away.
    gateway.setPaymentStatus(sessionId, 'PAID', 'pi_overtake');
    expect(await reconcile.execute(RECONCILE_ALL)).toMatchObject({ scanned: 1, finalized: 1 });
    expect((await readPayment(app, orderId)).status).toBe(PaymentStatus.SUCCEEDED);
    expect((await readOrder(app, orderId)).status).toBe(OrderStatus.PAID);
  });

  // CHARACTERIZATION — pins today's behaviour, which is NOT the intended one.
  //
  // Intended invariant: the event Stripe sends when a delayed payment method finally clears settles
  //   the payment it names — it is the ONLY notification that the money arrived, because the
  //   `checkout.session.completed` that preceded it was deliberately left unsettled as `unpaid`.
  // Violated at: src/modules/payment/application/mappers/map-event-to-outcome.ts:17-26 — the mapper
  //   knows two event types and folds everything else to `ignore`, so
  //   `checkout.session.async_payment_succeeded` is logged RECEIVED and applied to nothing. The
  //   payment stays PENDING on money that has cleared, until reconcile's poll happens to probe it.
  // Follow-up: plans/260910-1940-edge-case-invariant-fixes/plan.md — WH-3 (and matrix q4: whether
  //   async payment methods are in scope at all, or whether reconcile is the intended answer and the
  //   limit simply needs stating).
  it('logs an async payment success and applies it to nothing, leaving the payment PENDING on cleared money', async () => {
    const order = await placeAndOpenSession(app, sku, 1);

    // The pair a delayed method actually sends: the session completes `unpaid`...
    const completedUnpaid = signWebhook({
      secret: WEBHOOK_SECRET,
      event: checkoutSessionCompleted(
        order.sessionId,
        { ...order.charge, paymentStatus: 'unpaid' },
        { eventId: 'evt_async_completed' },
      ),
    });
    expect((await post(completedUnpaid).expect(200)).body).toEqual({ status: 'skipped' });
    expect(await webhookRow('evt_async_completed')).toMatchObject({ status: 'SKIPPED' });

    // ...and hours later the funds clear. Hand-built, because no helper produces an event the app
    // does not understand.
    const asyncSucceeded = signWebhook({
      secret: WEBHOOK_SECRET,
      event: {
        id: 'evt_async_succeeded',
        type: 'checkout.session.async_payment_succeeded',
        data: { object: { id: order.sessionId, payment_status: 'paid', ...toSessionCharge(order.charge) } },
      },
    });

    expect((await post(asyncSucceeded).expect(200)).body).toEqual({ status: 'ignored' });

    // RECEIVED, not SKIPPED: not even routed far enough to be refused.
    expect(await webhookRow('evt_async_succeeded')).toMatchObject({ status: 'RECEIVED' });
    expect((await readPayment(app, order.orderId)).status).toBe(PaymentStatus.PENDING);
    expect((await readOrder(app, order.orderId)).status).toBe(OrderStatus.PENDING);
  });

  // GUARD — the code holds this today; the test is here because nothing asserted it.
  // Two DIFFERENT events for one payment, delivered together, so the `webhook_events` unique index
  // that makes a redelivery a no-op does not apply and both reach the payment. The row lock at
  // payment.repository.ts:72 is what serializes them, and the loser's target is then refused by
  // `canTransition` rather than written over the winner's.
  it('lets exactly one of two racing settlements win and refuses the other in the domain', async () => {
    const order = await placeAndOpenSession(app, sku, 1);

    // `Promise.all` alone only hopes the two transactions overlap. If the first commits before the
    // second reads, the second is refused by `canTransition` on its own and every assertion below
    // still holds — the row lock would never have been contended, and deleting `.for('update')`
    // would leave this test green. So the winner is held inside its transaction until the loser has
    // provably parked on the lock that read took, which is the mechanism this guard is about.
    let held = false;
    const readLocked = payments.findByProviderSessionId.bind(payments);
    vi.spyOn(payments, 'findByProviderSessionId').mockImplementation(async (sessionId, tx) => {
      const row = await readLocked(sessionId, tx);
      if (tx && !held) {
        held = true;
        await waitUntilBlockedOnLock(pool, { subject: 'the second settlement' });
      }
      return row;
    });

    const [completed, expired] = await Promise.all([
      postWebhook(app, signOutcome(WEBHOOK_SECRET, order.sessionId, order.charge, 'PAID', 'evt_race_completed')),
      postWebhook(app, signOutcome(WEBHOOK_SECRET, order.sessionId, order.charge, 'FAILED', 'evt_race_expired')),
    ]);
    vi.restoreAllMocks();

    expect([completed.status, expired.status]).toEqual([200, 200]);
    // Whichever arrived first is immaterial; that exactly one applied is the invariant.
    expect([completed.body.status, expired.body.status].sort()).toEqual(['processed', 'skipped']);

    const rows = await webhookRows();
    expect(rows.map((row) => row.status).sort()).toEqual(['PROCESSED', 'SKIPPED']);

    const winner = rows.find((row) => row.status === 'PROCESSED');
    const expectedStatus =
      winner?.providerEventId === 'evt_race_completed' ? PaymentStatus.SUCCEEDED : PaymentStatus.FAILED;
    expect((await readPayment(app, order.orderId)).status).toBe(expectedStatus);
  });
});

/** The charge fields as the gateway nests them, for an event no helper builds. */
function toSessionCharge(charge: SessionCharge): Record<string, unknown> {
  return { amount_total: charge.amountMinor, currency: charge.currency?.toLowerCase() };
}
