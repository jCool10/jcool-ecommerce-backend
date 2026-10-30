import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import request from 'supertest';
import { DRIZZLE, type DrizzleDB } from '../../../src/database';
import * as schema from '../../../src/database/schema';
import { apiInternalStub } from '../api-internal-stub';
import { authHeader } from '../bearer.helper';
import { eventually } from '../eventually';
import { idempotencyKeyHeader } from '../idempotency.helper';
import { inventoryServiceStub } from '../inventory-service-stub';
import { paymentServiceStub } from '../payment-service-stub';
import { createTestProduct } from './catalog.fixture';
import { relayAuthorization } from './checkout-saga.fixture';
import { seedStock } from './inventory.fixture';
import { newPrincipalToken } from './principal.fixture';

export interface SellableSku {
  variantId: string;
  priceMinor: number;
  onHand: number;
}

export interface OpenOrder {
  token: string;
  orderId: string;
  /** The attempt `/pay` opened, the one a later authorization names. */
  paymentId: string;
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

/** The cart is the api's: the line goes onto the stub, under the user the token names. */
export async function addToCart(_app: INestApplication, token: string, skuId: string, quantity = 1): Promise<void> {
  const { sub } = decodeJwt(token);
  if (!sub) throw new Error('addToCart: the token names no user');
  (await apiInternalStub()).addLine(sub, skuId, quantity);
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
  return {
    token,
    orderId,
    paymentId: pay.body.paymentId as string,
    sessionId: pay.body.providerSessionId as string,
    variantId: sku.variantId,
    quantity,
  };
}

/** A PENDING order taken to PAID: `/pay`, the buyer's card hold and its `payment.authorized`, then the saga. */
export async function driveToPaid(app: INestApplication, token: string, orderId: string): Promise<void> {
  await openSession(app, token, orderId).expect(201);
  await authorizePayment(orderId);
  await relayAuthorization(app, orderId);
  await untilOrderStatus(app, orderId, 'PAID');
}

/**
 * The buyer completes the manual-capture session: payment holds the charge and queues
 * `payment.authorized` on order-events. Returns the attempt's payment id.
 */
export async function authorizePayment(orderId: string): Promise<string> {
  return (await paymentServiceStub()).authorize(orderId);
}

export function untilOrderStatus(app: INestApplication, orderId: string, status: string, timeoutMs?: number) {
  return eventually(
    async () => (await readOrder(app, orderId))?.status,
    (current) => current === status,
    timeoutMs,
  );
}

export async function readOrder(app: INestApplication, orderId: string) {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
  return row;
}

/** The order's newest attempt off the payment-service stub, so a retried session wins over its dead predecessor. */
export async function readPayment(_app: INestApplication, orderId: string) {
  return (await paymentServiceStub()).sessionFor(orderId);
}

/** The order's payment header off the stub, undefined when the participant never saw the order. */
export async function readPaymentOrder(_app: INestApplication, orderId: string) {
  return (await paymentServiceStub()).headerOf(orderId);
}

export interface StockRow {
  variantId: string;
  quantityOnHand: number;
  quantityReserved: number;
}

/** Off the inventory-service stub, under the column names the stock row had when it lived here. */
export async function readStock(_app: INestApplication, variantId: string) {
  const [row]: StockRow[] = (await inventoryServiceStub())
    .stockLevels()
    .filter((level) => level.variantId === variantId)
    .map((level) => ({ variantId, quantityOnHand: level.onHand, quantityReserved: level.reserved }));
  return row;
}

export async function reservationsFor(_app: INestApplication, orderId: string, variantId?: string) {
  const holds = (await inventoryServiceStub()).holdsOf(orderId);
  return variantId === undefined ? holds : holds.filter((hold) => hold.variantId === variantId);
}

export interface LedgerAuditReport {
  /** Asserted by callers so an audit over an empty DB can never read as "everything is fine". */
  orders: number;
  /** Orders still awaiting an outcome; a settled ledger has none left at rest. */
  pending: string[];
  /** One line per invariant breach; empty means money, stock, and status agree. */
  violations: string[];
}

/**
 * Cross-checks every row in the ledger, not just the ones a test happened to name. `seededOnHand`
 * (variantId → the on-hand the test seeded) turns the on-hand check from "not negative" into the
 * exact "seeded minus committed" equality.
 */
export async function auditLedgerInvariants(
  app: INestApplication,
  seededOnHand: Record<string, number> = {},
): Promise<LedgerAuditReport> {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const inventory = await inventoryServiceStub();
  const payment = await paymentServiceStub();
  const orders = await db.select().from(schema.orders);
  const payments = payment.attemptsOf();
  const paymentHeaders = payment.headersList();
  const reservations = inventory.holdsOf();
  const stockHeaders = inventory.headersList();

  const violations: string[] = [];
  const pending: string[] = [];

  for (const header of paymentHeaders) {
    // The service's `ck_payment_orders_amount_when_not_fenced` enforces it; the stub has no such check.
    if (header.status !== 'FENCED' && header.amountMinor === null) {
      violations.push(`payment header ${header.orderId} is ${header.status} without a charge`);
    }
  }

  for (const order of orders) {
    const holds = reservations.filter((r) => r.orderId === order.id);
    const linked = payments.filter((p) => p.orderId === order.id);
    const succeeded = linked.filter((p) => p.status === 'SUCCEEDED');
    const stockHeader = stockHeaders.find((h) => h.orderId === order.id)?.status;
    const paymentHeader = paymentHeaders.find((h) => h.orderId === order.id)?.status;

    if (succeeded.length > 1) {
      violations.push(`order ${order.id}: ${succeeded.length} SUCCEEDED payments: double charge`);
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
        if (stockHeader !== 'COMMITTED') violations.push(`PAID order ${order.id} has stock header ${stockHeader}`);
        if (paymentHeader !== 'CAPTURED') violations.push(`PAID order ${order.id} has payment header ${paymentHeader}`);
        break;
      }
      case 'FAILED':
      case 'EXPIRED':
      case 'CANCELLED': {
        if (holds.length === 0) violations.push(`${order.status} order ${order.id} settled without ever holding stock`);
        // RESTOCKED is a commit undone after a failed capture: the units are back on the shelf.
        const wrong = holds.filter((r) => r.status !== 'RELEASED' && r.status !== 'RESTOCKED');
        if (wrong.length > 0)
          violations.push(`${order.status} order ${order.id} still holds stock: ${statuses(wrong)}`);
        if (succeeded.length > 0) {
          violations.push(`${order.status} order ${order.id} carries a SUCCEEDED payment: money without an order`);
        }
        const authorized = linked.filter((p) => p.status === 'AUTHORIZED');
        if (authorized.length > 0 || paymentHeader === 'AUTHORIZED') {
          violations.push(`${order.status} order ${order.id} left a card hold in place`);
        }
        if (stockHeader === 'HELD') violations.push(`${order.status} order ${order.id} has its stock header HELD`);
        break;
      }
      case 'REJECTED': {
        const held = holds.filter((r) => r.status === 'HELD');
        if (held.length > 0) violations.push(`REJECTED order ${order.id} still holds stock: ${statuses(held)}`);
        if (stockHeader === 'HELD') violations.push(`REJECTED order ${order.id} has its stock header HELD`);
        if (linked.length > 0) violations.push(`REJECTED order ${order.id} has payments: [${statuses(linked)}]`);
        break;
      }
      case 'RESERVING':
      case 'CONFIRMING':
        violations.push(`order ${order.id} is still ${order.status}: its saga never got past that step`);
        break;
      default:
        // DRAFT, or anything a later state machine adds: unclassified, so unaudited, not benign.
        violations.push(`order ${order.id} sits in ${order.status}, which this audit does not know how to check`);
    }
  }

  for (const row of inventory.stockLevels()) {
    const forVariant = reservations.filter((r) => r.variantId === row.variantId);
    const held = sumQuantity(forVariant.filter((r) => r.status === 'HELD'));
    const committed = sumQuantity(forVariant.filter((r) => r.status === 'COMMITTED'));

    if (row.onHand < 0) violations.push(`sku ${row.variantId}: on-hand ${row.onHand} is negative`);
    // The service's `ck_stock_no_oversell` enforces this; the stub has no such check, so this is it.
    if (row.reserved > row.onHand) {
      violations.push(`sku ${row.variantId}: oversold, reserved ${row.reserved} > on-hand ${row.onHand}`);
    }
    if (row.reserved !== held) {
      violations.push(`sku ${row.variantId}: reserved ${row.reserved} but ${held} units are HELD`);
    }
    const seeded = seededOnHand[row.variantId];
    if (seeded !== undefined && row.onHand !== seeded - committed) {
      violations.push(
        `sku ${row.variantId}: on-hand ${row.onHand}, expected ${seeded - committed} (seeded ${seeded} − committed ${committed})`,
      );
    }
  }

  return { orders: orders.length, pending, violations };
}

const statuses = (rows: { status: string }[]): string => rows.map((r) => r.status).join(', ');
const sumQuantity = (rows: { quantity: number }[]): number => rows.reduce((total, r) => total + r.quantity, 0);
