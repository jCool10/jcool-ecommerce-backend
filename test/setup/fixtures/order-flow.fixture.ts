import type { INestApplication } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import request from 'supertest';
import { DRIZZLE, type DrizzleDB } from '../../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../../src/shared/infrastructure/database/schema';
import { authHeader } from '../auth.helper';
import { idempotencyKeyHeader } from '../idempotency.helper';
import {
  checkoutSessionCompleted,
  checkoutSessionExpired,
  signWebhook,
  type SignedWebhook,
} from '../sign-webhook.helper';
import { createTestProduct } from './catalog.fixture';
import { seedStock } from './inventory.fixture';
import { createTestUser } from './user.fixture';

// The buy pipeline as a customer walks it — cart → checkout → payment session → webhook — plus the
// ledger audit that reads money, stock, and status back out of Postgres and checks they agree.

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

/** A fresh buyer with the SKU already in their cart — checkout isolates by user, so each one races alone. */
export async function buyerWithCart(app: INestApplication, variantId: string, quantity = 1): Promise<string> {
  const { accessToken } = await createTestUser(app);
  await request(app.getHttpServer())
    .post('/cart/items')
    .set(authHeader(accessToken))
    .send({ skuId: variantId, quantity })
    .expect(200);
  return accessToken;
}

export function checkout(app: INestApplication, token: string): request.Test {
  return request(app.getHttpServer()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());
}

export function openSession(app: INestApplication, token: string, orderId: string): request.Test {
  return request(app.getHttpServer()).post(`/orders/${orderId}/pay`).set(authHeader(token));
}

/** The whole path up to "buyer is looking at the hosted page": order PENDING, hold HELD, session open. */
export async function placeAndOpenSession(app: INestApplication, sku: SellableSku, quantity = 1): Promise<OpenOrder> {
  const token = await buyerWithCart(app, sku.variantId, quantity);
  const order = await checkout(app, token).expect(201);
  const orderId = order.body.id as string;
  const pay = await openSession(app, token, orderId).expect(201);
  return { token, orderId, sessionId: pay.body.providerSessionId as string, variantId: sku.variantId, quantity };
}

export type WebhookOutcome = 'PAID' | 'FAILED';

export function signOutcome(
  secret: string,
  sessionId: string,
  outcome: WebhookOutcome,
  eventId: string,
  paymentIntent = 'pi_m2',
): SignedWebhook {
  const event =
    outcome === 'PAID'
      ? checkoutSessionCompleted(sessionId, { eventId, paymentIntent })
      : checkoutSessionExpired(sessionId, { eventId });
  return signWebhook({ secret, event });
}

export function postWebhook(app: INestApplication, signed: SignedWebhook): request.Test {
  return request(app.getHttpServer()).post('/webhooks/payment').set(signed.headers).send(signed.rawBody);
}

export async function readOrder(app: INestApplication, orderId: string) {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
  return row;
}

/** The active payment for an order — newest first, so a retried session wins over its dead predecessor. */
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

export async function readStock(app: INestApplication, variantId: string) {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const [row] = await db.select().from(schema.stockLevels).where(eq(schema.stockLevels.variantId, variantId));
  return row;
}

export interface M2AuditReport {
  /** Asserted by callers so an audit over an empty DB can never read as "everything is fine". */
  orders: number;
  /** Orders still awaiting an outcome — the M2 acceptance requires this to be empty at rest. */
  pending: string[];
  /** One line per invariant breach; empty means money, stock, and status agree. */
  violations: string[];
}

/**
 * Read the whole ledger back and cross-check the M2 invariant on every row, not just the ones a test
 * happened to name: a settled order's holds match its outcome, its payment matches its amount, and
 * every stock row still equals what its reservations say it should be.
 *
 * `seededOnHand` (variantId → the on-hand the test seeded) turns the on-hand check from "not negative"
 * into the exact "seeded minus committed" equality.
 */
export async function auditM2Invariants(
  app: INestApplication,
  seededOnHand: Record<string, number> = {},
): Promise<M2AuditReport> {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const [orders, reservations, payments, stock] = await Promise.all([
    db.select().from(schema.orders),
    db.select().from(schema.reservations),
    db.select().from(schema.payments),
    db.select().from(schema.stockLevels),
  ]);

  const violations: string[] = [];
  const pending: string[] = [];

  for (const order of orders) {
    const holds = reservations.filter((r) => r.orderId === order.id);
    const linked = payments.filter((p) => p.orderId === order.id);
    const succeeded = linked.filter((p) => p.status === 'SUCCEEDED');

    if (succeeded.length > 1) {
      violations.push(`order ${order.id}: ${succeeded.length} SUCCEEDED payments — double charge`);
    }
    for (const payment of linked) {
      if (payment.amountMinor !== order.totalAmount) {
        violations.push(`order ${order.id}: payment charges ${payment.amountMinor}, order totals ${order.totalAmount}`);
      }
    }

    switch (order.status) {
      case 'PENDING':
        pending.push(order.id);
        break;
      case 'PAID': {
        // Zero holds is the dangerous case, not a benign one: charged, and nothing ever left the shelf.
        if (holds.length === 0) violations.push(`PAID order ${order.id} settled without ever holding stock`);
        const wrong = holds.filter((r) => r.status !== 'COMMITTED');
        if (wrong.length > 0) violations.push(`PAID order ${order.id} has non-committed holds: ${statuses(wrong)}`);
        if (succeeded.length !== 1) {
          violations.push(`PAID order ${order.id} has no SUCCEEDED payment: [${statuses(linked)}]`);
        }
        break;
      }
      case 'FAILED':
      case 'EXPIRED': {
        if (holds.length === 0) violations.push(`${order.status} order ${order.id} settled without ever holding stock`);
        const wrong = holds.filter((r) => r.status !== 'RELEASED');
        if (wrong.length > 0)
          violations.push(`${order.status} order ${order.id} still holds stock: ${statuses(wrong)}`);
        if (succeeded.length > 0) {
          violations.push(`${order.status} order ${order.id} carries a SUCCEEDED payment — money without an order`);
        }
        break;
      }
      default:
        // DRAFT, CANCELLED, or anything a later state machine adds: unclassified, so unaudited.
        violations.push(`order ${order.id} sits in ${order.status}, which this audit does not know how to check`);
    }
  }

  for (const row of stock) {
    const forVariant = reservations.filter((r) => r.variantId === row.variantId);
    const held = sumQuantity(forVariant.filter((r) => r.status === 'HELD'));
    const committed = sumQuantity(forVariant.filter((r) => r.status === 'COMMITTED'));

    if (row.quantityOnHand < 0) violations.push(`sku ${row.variantId}: on-hand ${row.quantityOnHand} is negative`);
    // The oversell invariant itself. `ck_stock_no_oversell` enforces it in Postgres; asserting it here
    // means dropping that constraint shows up as a failure instead of silently widening what can commit.
    if (row.quantityReserved > row.quantityOnHand) {
      violations.push(
        `sku ${row.variantId}: oversold — reserved ${row.quantityReserved} > on-hand ${row.quantityOnHand}`,
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
