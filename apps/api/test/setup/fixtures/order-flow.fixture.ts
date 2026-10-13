import type { INestApplication } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import request from 'supertest';
import { isTerminalSagaStep, type CheckoutSagaStep } from '../../../src/modules/order/domain/checkout-saga-step';
import type { FakeSignerGatewayAdapter } from '../../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { DRIZZLE, type DrizzleDB } from '../../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../../src/shared/infrastructure/database/schema';
import { authHeader } from '../bearer.helper';
import { sagaStepAttribute } from '../checkout-sagas';
import { drainDomainEvents, type DrainedEvent } from '../domain-events';
import { idempotencyKeyHeader } from '../idempotency.helper';
import {
  checkoutSessionCompleted,
  checkoutSessionExpired,
  signWebhook,
  signWebhookAs,
  type SessionCharge,
  type SignedWebhook,
} from '../sign-webhook.helper';
import { createTestProduct } from './catalog.fixture';
import { seedStock } from './inventory.fixture';
import { newPrincipalToken } from './principal.fixture';

export {
  describeSaga,
  readSagaState,
  sagaHandle,
  sagaStepAttribute,
  waitForSagaClosed,
  waitForSagaState,
  waitForSagaStep,
} from '../checkout-sagas';

export interface SellableSku {
  variantId: string;
  priceMinor: number;
  onHand: number;
}

export interface OpenOrder {
  token: string;
  orderId: string;
  sessionId: string;
  variantId: string;
  quantity: number;
  /** The charge recorded on the payment, which a settling webhook must report exactly. */
  charge: SessionCharge;
}

export async function seedSellableSku(
  app: INestApplication,
  options: { onHand: number; priceMinor?: number },
): Promise<SellableSku> {
  const priceMinor = options.priceMinor ?? 150_000;
  const { variantId } = await createTestProduct(app, { priceMinor });
  await seedStock(app, variantId, options.onHand);
  return { variantId, priceMinor, onHand: options.onHand };
}

/**
 * Returns the supertest chain so a caller can assert on the response body, but the 200 is baked in:
 * this is an arrangement step for the checkout tests, never the subject. A spec that needs a
 * non-200 add-to-cart builds the request itself rather than reaching for this.
 */
export function addToCart(app: INestApplication, token: string, skuId: string, quantity = 1): request.Test {
  return request(app.getHttpServer()).post('/cart/items').set(authHeader(token)).send({ skuId, quantity }).expect(200);
}

/** Checkout isolates by user, so each buyer races alone. */
export async function buyerWithCart(app: INestApplication, variantId: string, quantity = 1): Promise<string> {
  const accessToken = await newPrincipalToken(app);
  await addToCart(app, accessToken, variantId, quantity);
  return accessToken;
}

export function checkout(app: INestApplication, token: string): request.Test {
  return request(app.getHttpServer()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());
}

export function openSession(app: INestApplication, token: string, orderId: string): request.Test {
  return request(app.getHttpServer()).post(`/orders/${orderId}/pay`).set(authHeader(token));
}

/** Leaves the order PENDING, the hold HELD, and the session open. */
export async function placeAndOpenSession(app: INestApplication, sku: SellableSku, quantity = 1): Promise<OpenOrder> {
  const token = await buyerWithCart(app, sku.variantId, quantity);
  const order = await checkout(app, token).expect(201);
  const orderId = order.body.id as string;
  const pay = await openSession(app, token, orderId).expect(201);
  const recorded = await readPayment(app, orderId);
  return {
    token,
    orderId,
    sessionId: pay.body.providerSessionId as string,
    variantId: sku.variantId,
    quantity,
    charge: { amountMinor: recorded.amountMinor, currency: recorded.currency },
  };
}

export type WebhookOutcome = 'PAID' | 'FAILED';

export function signOutcome(
  secret: string,
  sessionId: string,
  charge: SessionCharge,
  outcome: WebhookOutcome,
  eventId: string,
  paymentIntent = 'pi_e2e',
): SignedWebhook {
  const event =
    outcome === 'PAID'
      ? checkoutSessionCompleted(sessionId, charge, { eventId, paymentIntent })
      : checkoutSessionExpired(sessionId, { eventId });
  return signWebhook({ secret, event });
}

export function postWebhook(app: INestApplication, signed: SignedWebhook): request.Test {
  return request(app.getHttpServer()).post('/webhooks/payment').set(signed.headers).send(signed.rawBody);
}

/** Stripe reports the page completed with the money held, not taken; nothing is relayed yet. */
export async function postAuthorizationWebhook(
  app: INestApplication,
  gateway: FakeSignerGatewayAdapter,
  order: OpenOrder,
  eventId = `evt_authorized_${order.orderId}`,
): Promise<void> {
  const event = checkoutSessionCompleted(order.sessionId, { ...order.charge, paymentStatus: 'unpaid' }, { eventId });
  await postWebhook(app, signWebhookAs(gateway, event)).expect(200);
}

/**
 * The buyer pays: Stripe places the hold (for the session's charge unless `held` says otherwise), the
 * webhook lands, `payment.authorized` is relayed to the saga, and the drain waits for it to close.
 */
export async function authorizeAndRelay(
  app: INestApplication,
  gateway: FakeSignerGatewayAdapter,
  order: OpenOrder,
  options: { eventId?: string; held?: { amountMinor?: number; currency?: string } } = {},
): Promise<{ intentId: string; drained: DrainedEvent[] }> {
  const intentId = gateway.authorize(order.sessionId, options.held);
  await postAuthorizationWebhook(app, gateway, order, options.eventId);
  return { intentId, drained: await drainDomainEvents(app) };
}

export async function readReservationOrder(app: INestApplication, orderId: string) {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const [row] = await db.select().from(schema.reservationOrders).where(eq(schema.reservationOrders.orderId, orderId));
  return row;
}

export async function readOrder(app: INestApplication, orderId: string) {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
  return row;
}

/** Newest first, so a retried session wins over its dead predecessor. */
export async function readPayment(app: INestApplication, orderId: string) {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const [row] = await db
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.orderId, orderId))
    .orderBy(desc(schema.payments.createdAt))
    .limit(1);
  return row;
}

export async function readPaymentOrder(app: INestApplication, orderId: string) {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const [row] = await db.select().from(schema.paymentOrders).where(eq(schema.paymentOrders.orderId, orderId));
  return row;
}

export async function readStock(app: INestApplication, variantId: string) {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const [row] = await db.select().from(schema.stockLevels).where(eq(schema.stockLevels.variantId, variantId));
  return row;
}

/**
 * The hold an order placed. `variantId` narrows it for the multi-line cases; an order with one line
 * has exactly one reservation either way.
 */
export async function readReservation(app: INestApplication, orderId: string, variantId?: string) {
  const [row] = await reservationsFor(app, orderId, variantId);
  return row;
}

export async function reservationsFor(app: INestApplication, orderId: string, variantId?: string) {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const byOrder = eq(schema.reservations.orderId, orderId);
  return db
    .select()
    .from(schema.reservations)
    .where(variantId === undefined ? byOrder : and(byOrder, eq(schema.reservations.variantId, variantId)));
}

/** Ages a hold past its expiry, the one thing a test cannot wait for. */
export async function lapseReservation(app: INestApplication, orderId: string, minutesAgo = 30): Promise<void> {
  const db = app.get<DrizzleDB>(DRIZZLE);
  await db
    .update(schema.reservations)
    .set({ expiresAt: new Date(Date.now() - minutesAgo * 60_000) })
    .where(eq(schema.reservations.orderId, orderId));
}

export interface LedgerAuditReport {
  /** Asserted by callers so an audit over an empty DB can never read as "everything is fine". */
  orders: number;
  /** Orders whose saga is still moving; a settled ledger has none left at rest. */
  pending: string[];
  /** One line per invariant breach; empty means money, stock, and status agree. */
  violations: string[];
}

const SAGA_STEPS_FOR: Record<string, readonly CheckoutSagaStep[]> = {
  RESERVING: ['RESERVING'],
  PENDING: ['AWAITING_AUTH'],
  CONFIRMING: ['COMMITTING_STOCK', 'CAPTURING'],
  PAID: ['COMPLETED'],
  REJECTED: ['COMPENSATING', 'COMPENSATED'],
  FAILED: ['COMPENSATING', 'COMPENSATED'],
  EXPIRED: ['COMPENSATING', 'COMPENSATED'],
  CANCELLED: ['COMPENSATING', 'COMPENSATED'],
};

/**
 * Cross-checks every row in the ledger, not just the ones a test happened to name. `seededOnHand`
 * (variantId → the on-hand the test seeded) turns the on-hand check from "not negative" into the
 * exact "seeded minus committed" equality. Money and stock are only held to their resting state once
 * the order's saga has settled; until then the order is reported pending.
 */
export async function auditLedgerInvariants(
  app: INestApplication,
  seededOnHand: Record<string, number> = {},
): Promise<LedgerAuditReport> {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const [orders, reservations, stockHeaders, payments, paymentHeaders, stock] = await Promise.all([
    db.select().from(schema.orders),
    db.select().from(schema.reservations),
    db.select().from(schema.reservationOrders),
    db.select().from(schema.payments),
    db.select().from(schema.paymentOrders),
    db.select().from(schema.stockLevels),
  ]);
  const sagaSteps = new Map(
    await Promise.all(orders.map(async (order) => [order.id, await sagaStepAttribute(app, order.id)] as const)),
  );

  const violations: string[] = [];
  const pending: string[] = [];

  for (const order of orders) {
    const sagaStep = sagaSteps.get(order.id) ?? null;
    const holds = reservations.filter((r) => r.orderId === order.id);
    const stockHeader = stockHeaders.find((h) => h.orderId === order.id);
    const linked = payments.filter((p) => p.orderId === order.id);
    const paymentHeader = paymentHeaders.find((h) => h.orderId === order.id);
    const succeeded = linked.filter((p) => p.status === 'SUCCEEDED');
    const flag = (breach: string) => violations.push(`${order.status} order ${order.id} ${breach}`);

    if (succeeded.length > 1) flag(`has ${succeeded.length} SUCCEEDED payments: double charge`);
    for (const payment of linked) {
      if (payment.amountMinor !== order.totalAmount) {
        flag(`has a payment charging ${payment.amountMinor} against a total of ${order.totalAmount}`);
      }
    }
    if (paymentHeader) {
      if ((paymentHeader.status === 'FENCED') !== (paymentHeader.amountMinor === null)) {
        flag(`has a ${paymentHeader.status} payment header with amount ${paymentHeader.amountMinor}`);
      }
      if (paymentHeader.amountMinor !== null && paymentHeader.amountMinor !== order.totalAmount) {
        flag(`has a payment header for ${paymentHeader.amountMinor} against a total of ${order.totalAmount}`);
      }
    }

    const expectedSteps = SAGA_STEPS_FOR[order.status];
    if (expectedSteps === undefined) {
      // DRAFT, or anything a later state machine adds: unclassified, so unaudited, not benign.
      flag('sits in a status this audit does not know how to check');
      continue;
    }
    if (sagaStep === null) {
      // Tx A committed but the start never reached Temporal; the reaper owns it from here.
      if (order.status === 'RESERVING') pending.push(order.id);
      else flag('has no checkout saga');
      continue;
    }
    if (!expectedSteps.includes(sagaStep)) flag(`has its saga at ${sagaStep}`);
    if (!isTerminalSagaStep(sagaStep)) {
      pending.push(order.id);
      continue;
    }
    if (order.finalizedAt === null) flag('was never stamped finalized');

    if (order.status === 'PAID') {
      // Zero holds is the dangerous case, not a benign one: charged, and nothing ever left the shelf.
      if (holds.length === 0) flag('settled without ever holding stock');
      const uncommitted = holds.filter((r) => r.status !== 'COMMITTED');
      if (uncommitted.length > 0) flag(`has non-committed holds: ${statuses(uncommitted)}`);
      if (succeeded.length !== 1) flag(`has no SUCCEEDED payment: [${statuses(linked)}]`);
      if (stockHeader?.status !== 'COMMITTED') flag(`has a ${stockHeader?.status ?? 'missing'} stock header`);
      if (paymentHeader?.status !== 'CAPTURED') flag(`has a ${paymentHeader?.status ?? 'missing'} payment header`);
      continue;
    }

    // Nothing was sold: every unit back on the shelf and no money taken or still held.
    if (holds.length === 0 && order.status !== 'REJECTED') flag('settled without ever holding stock');
    const kept = holds.filter((r) => r.status !== 'RELEASED' && r.status !== 'RESTOCKED');
    if (kept.length > 0) flag(`still holds stock: ${statuses(kept)}`);
    if (stockHeader && !['RELEASED', 'RESTOCKED', 'FENCED'].includes(stockHeader.status)) {
      flag(`has a ${stockHeader.status} stock header`);
    }
    const unreturned = linked.filter((p) => p.status === 'SUCCEEDED' || p.status === 'AUTHORIZED');
    if (unreturned.length > 0) flag(`still has money taken or held: ${statuses(unreturned)}`);
    if (paymentHeader && !['CANCELLED', 'FENCED'].includes(paymentHeader.status)) {
      flag(`has a ${paymentHeader.status} payment header`);
    }
    if (order.status === 'REJECTED' && linked.length > 0) flag('was never placed but has a payment');
  }

  for (const row of stock) {
    const forVariant = reservations.filter((r) => r.variantId === row.variantId);
    const held = sumQuantity(forVariant.filter((r) => r.status === 'HELD'));
    const committed = sumQuantity(forVariant.filter((r) => r.status === 'COMMITTED'));

    if (row.quantityOnHand < 0) violations.push(`sku ${row.variantId}: on-hand ${row.quantityOnHand} is negative`);
    // `ck_stock_no_oversell` enforces this in Postgres; re-asserting it here means dropping that
    // constraint fails the suite instead of silently widening what can commit.
    if (row.quantityReserved > row.quantityOnHand) {
      violations.push(
        `sku ${row.variantId}: oversold, reserved ${row.quantityReserved} > on-hand ${row.quantityOnHand}`,
      );
    }
    if (row.quantityReserved !== held) {
      violations.push(`sku ${row.variantId}: reserved ${row.quantityReserved} but ${held} units are HELD`);
    }
    const seeded = seededOnHand[row.variantId];
    if (seeded !== undefined && row.quantityOnHand !== seeded - committed) {
      violations.push(
        `sku ${row.variantId}: on-hand ${row.quantityOnHand}, expected ${seeded - committed} (seeded ${seeded} − committed ${committed})`,
      );
    }
  }

  return { orders: orders.length, pending, violations };
}

const statuses = (rows: { status: string }[]): string => rows.map((r) => r.status).join(', ');
const sumQuantity = (rows: { quantity: number }[]): number => rows.reduce((total, r) => total + r.quantity, 0);
