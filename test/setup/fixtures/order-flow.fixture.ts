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
  type SessionCharge,
  type SignedWebhook,
} from '../sign-webhook.helper';
import { createTestProduct } from './catalog.fixture';
import { seedStock } from './inventory.fixture';
import { createTestUser } from './user.fixture';

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
  /** The charge recorded on the payment — a settling webhook must report exactly this. */
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

/** Checkout isolates by user, so each buyer races alone. */
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
  paymentIntent = 'pi_m2',
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

export async function readStock(app: INestApplication, variantId: string) {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const [row] = await db.select().from(schema.stockLevels).where(eq(schema.stockLevels.variantId, variantId));
  return row;
}

export interface M2AuditReport {
  /** Asserted by callers so an audit over an empty DB can never read as "everything is fine". */
  orders: number;
  /** Orders still awaiting an outcome — the M2 acceptance requires this empty at rest. */
  pending: string[];
  /** One line per invariant breach; empty means money, stock, and status agree. */
  violations: string[];
}

/**
 * Cross-checks every row in the ledger, not just the ones a test happened to name. `seededOnHand`
 * (variantId → the on-hand the test seeded) turns the on-hand check from "not negative" into the
 * exact "seeded minus committed" equality.
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
      case 'EXPIRED':
      case 'CANCELLED': {
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
        // DRAFT, or anything a later state machine adds: unclassified, so unaudited — not benign.
        violations.push(`order ${order.id} sits in ${order.status}, which this audit does not know how to check`);
    }
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
