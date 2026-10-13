import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { drainDomainEvents } from '../setup/domain-events';
import {
  auditLedgerInvariants,
  buyerWithCart,
  checkout,
  describeSaga,
  openSession,
  placeAndOpenSession,
  postAuthorizationWebhook,
  readOrder,
  readPayment,
  readReservationOrder,
  readSagaState,
  readStock,
  sagaStepAttribute,
  seedSellableSku,
  waitForSagaClosed,
  waitForSagaState,
  type OpenOrder,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway } from '../setup/harness';
import { resetDatabase } from '../setup/reset-database';
import { sleep } from '../setup/sleep';

const WEBHOOK_SECRET = 'whsec_e2e_checkout_saga_expiry_01';
const ON_HAND = 10;
const PAYMENT_DEADLINE_SEC = 45;
const PAY_CUTOFF_SEC = 30;
const AUTH_GRACE_SEC = 5;
const RETRY_CAP_MS = 2_000;
// The late-relay order closes before the in-grace order's deadline, so draining one never signals the other.
const STAGGER_MS = 6_000;

/**
 * Timers live on the Temporal server, so nothing here moves a deadline: every case waits on the real
 * clock. The orders are placed together up front and the cases are ordered by when each is due.
 */
describe('Checkout saga, payment deadline (integration, real Postgres, real Temporal, real HMAC)', () => {
  let app: INestApplication;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let sku: SellableSku;

  let unpaid: OpenOrder;
  let lateRelay: OpenOrder;
  let lateWebhook: OpenOrder;
  let failingExpiry: OpenOrder;
  let noSession: { token: string; orderId: string };
  let inGrace: OpenOrder;
  let lateRelayIntent: string;
  let lateWebhookIntent: string;
  let inGraceIntent: string;

  const deadlineOf = async (orderId: string): Promise<number> => {
    const { paymentDeadlineAt } = await readOrder(app, orderId);
    return paymentDeadlineAt!.getTime();
  };
  const sleepUntil = async (atMs: number) => {
    const waitMs = atMs - Date.now();
    if (waitMs > 0) await sleep(waitMs);
  };
  const graceEndOf = async (orderId: string) => (await deadlineOf(orderId)) + AUTH_GRACE_SEC * 1000;
  const closed = (orderId: string) => waitForSagaClosed(app, orderId, { timeoutMs: 90_000 });
  const orderEvent = (orderId: string, eventType: string) =>
    db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.aggregateId, orderId), eq(schema.outbox.eventType, eventType)));

  beforeAll(async () => {
    let pool: Pool;
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, {
      CHECKOUT_PAYMENT_DEADLINE_SEC: String(PAYMENT_DEADLINE_SEC),
      CHECKOUT_PAY_CUTOFF_SEC: String(PAY_CUTOFF_SEC),
      SAGA_AUTH_GRACE_SEC: String(AUTH_GRACE_SEC),
      CHECKOUT_HOLD_SAFETY_SEC: '30',
      PAYMENT_SESSION_MIN_TTL_SEC: '0',
      PAYMENT_SESSION_EXPIRY_MARGIN_SEC: '0',
      SAGA_RETRY_BASE_MS: '200',
      SAGA_RETRY_CAP_MS: String(RETRY_CAP_MS),
    }));
    await resetDatabase(pool);
    sku = await seedSellableSku(app, { onHand: ON_HAND });

    // Authorized at the gateway and reported, but nothing is relayed until the saga has closed.
    lateRelay = await placeAndOpenSession(app, sku, 1);
    lateRelayIntent = gateway.authorize(lateRelay.sessionId);
    await postAuthorizationWebhook(app, gateway, lateRelay);

    unpaid = await placeAndOpenSession(app, sku, 1);
    // Authorized at the gateway; its webhook only arrives once the saga has closed.
    lateWebhook = await placeAndOpenSession(app, sku, 1);
    lateWebhookIntent = gateway.authorize(lateWebhook.sessionId);
    failingExpiry = await placeAndOpenSession(app, sku, 1);
    gateway.failExpireSession(failingExpiry.sessionId);
    const token = await buyerWithCart(app, sku.variantId, 1);
    noSession = { token, orderId: (await checkout(app, token).expect(201)).body.id as string };

    await sleepUntil((await deadlineOf(lateRelay.orderId)) + STAGGER_MS - PAYMENT_DEADLINE_SEC * 1000);
    inGrace = await placeAndOpenSession(app, sku, 1);
    inGraceIntent = gateway.authorize(inGrace.sessionId);
  }, 60_000);
  closeAppAfterAll(() => app);

  it('refuses to open a payment page once too little of the deadline is left to finish it', async () => {
    await sleepUntil((await deadlineOf(noSession.orderId)) - PAY_CUTOFF_SEC * 1000 + 500);

    const refused = await openSession(app, noSession.token, noSession.orderId).expect(409);

    expect(refused.body.message).toBe('Payment window closed');
    expect((await readOrder(app, noSession.orderId)).status).toBe('PENDING');
  }, 60_000);

  it('expires an order that got no authorization past its deadline and grace, closing the session and the hold', async () => {
    const description = await closed(unpaid.orderId);

    expect(Date.now()).toBeGreaterThanOrEqual(await graceEndOf(unpaid.orderId));
    expect(description.status.name).toBe('COMPLETED');
    expect(await readOrder(app, unpaid.orderId)).toMatchObject({ status: 'EXPIRED', finalizeReason: 'saga:deadline' });
    expect(await readSagaState(app, unpaid.orderId)).toMatchObject({ step: 'COMPENSATED', pendingCompensations: [] });
    expect(await sagaStepAttribute(app, unpaid.orderId)).toBe('COMPENSATED');
    expect(await readReservationOrder(app, unpaid.orderId)).toMatchObject({ status: 'RELEASED' });
    expect(gateway.wasExpired(unpaid.sessionId)).toBe(true);
    expect(await orderEvent(unpaid.orderId, 'order.expired')).toHaveLength(1);
  }, 90_000);

  it('voids a hold whose authorization is relayed only after the saga closed, never capturing it', async () => {
    await closed(lateRelay.orderId);
    expect((await readOrder(app, lateRelay.orderId)).status).toBe('EXPIRED');

    await drainDomainEvents(app);

    const late = await describeSaga(app, lateRelay.orderId);
    expect(late?.status.name).toBe('COMPLETED');
    // Only the run started by the late signal reports no deadline.
    expect(await readSagaState(app, lateRelay.orderId)).toEqual({
      step: 'COMPENSATED',
      pendingCompensations: [],
      deadlineAt: null,
    });
    expect((await readOrder(app, lateRelay.orderId)).status).toBe('EXPIRED');
    expect(gateway.wasVoided(lateRelayIntent)).toBe(true);
    expect(gateway.captureCalls(lateRelayIntent)).toBe(0);
    expect((await readPayment(app, lateRelay.orderId)).status).toBe('VOIDED');
  }, 90_000);

  it('voids a hold placed just before the expiry closed the page, and ignores its webhook after', async () => {
    await closed(lateWebhook.orderId);

    await postAuthorizationWebhook(app, gateway, lateWebhook);
    await drainDomainEvents(app);

    expect((await readOrder(app, lateWebhook.orderId)).status).toBe('EXPIRED');
    expect(gateway.wasVoided(lateWebhookIntent)).toBe(true);
    expect(gateway.captureCalls(lateWebhookIntent)).toBe(0);
    expect((await readPayment(app, lateWebhook.orderId)).status).toBe('VOIDED');
  }, 90_000);

  it('releases the hold at once while a session that will not close keeps the saga compensating', async () => {
    // The release runs alongside the failing expire, so wait for it to finish rather than for the step.
    const stuck = await waitForSagaState(
      app,
      failingExpiry.orderId,
      ({ step, pendingCompensations }) => step === 'COMPENSATING' && !pendingCompensations.includes('RELEASE_STOCK'),
      { timeoutMs: 90_000 },
    );

    expect(stuck.pendingCompensations).toEqual(['CANCEL_PAYMENT']);
    expect((await readOrder(app, failingExpiry.orderId)).status).toBe('EXPIRED');
    expect(await readReservationOrder(app, failingExpiry.orderId)).toMatchObject({ status: 'RELEASED' });
    expect((await describeSaga(app, failingExpiry.orderId))?.status.name).toBe('RUNNING');
    expect(await sagaStepAttribute(app, failingExpiry.orderId)).toBe('COMPENSATING');
    expect(gateway.wasExpired(failingExpiry.sessionId)).toBe(false);

    gateway.restoreExpireSession(failingExpiry.sessionId);

    const description = await waitForSagaClosed(app, failingExpiry.orderId, { timeoutMs: RETRY_CAP_MS + 5_000 });
    expect(description.status.name).toBe('COMPLETED');
    expect(await sagaStepAttribute(app, failingExpiry.orderId)).toBe('COMPENSATED');
    expect(gateway.wasExpired(failingExpiry.sessionId)).toBe(true);
  }, 90_000);

  it('still takes an authorization that lands past the deadline but inside the grace', async () => {
    const deadlineAt = await deadlineOf(inGrace.orderId);
    await sleepUntil(deadlineAt + 500);
    expect(await readSagaState(app, inGrace.orderId)).toMatchObject({ step: 'AWAITING_AUTH' });

    await postAuthorizationWebhook(app, gateway, inGrace);
    await drainDomainEvents(app);

    expect(Date.now()).toBeGreaterThan(deadlineAt);
    expect((await readOrder(app, inGrace.orderId)).status).toBe('PAID');
    expect((await closed(inGrace.orderId)).status.name).toBe('COMPLETED');
    expect(await sagaStepAttribute(app, inGrace.orderId)).toBe('COMPLETED');
    expect(gateway.captureCalls(inGraceIntent)).toBe(1);
    expect(gateway.wasVoided(inGraceIntent)).toBe(false);
    expect(gateway.wasExpired(inGrace.sessionId)).toBe(false);
    expect((await readPayment(app, inGrace.orderId)).status).toBe('SUCCEEDED');
  }, 90_000);

  it('leaves money, stock and order status in agreement once every saga has settled', async () => {
    await closed(noSession.orderId);
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: ON_HAND - 1, quantityReserved: 0 });

    await expect(auditLedgerInvariants(app, { [sku.variantId]: ON_HAND })).resolves.toEqual({
      orders: 6,
      pending: [],
      violations: [],
    });
  }, 90_000);
});
