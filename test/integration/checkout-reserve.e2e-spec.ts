import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/auth.helper';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { addToCart } from '../setup/fixtures/order-flow.fixture';
import { newUserToken } from '../setup/fixtures/user.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

// Single-thread proof that POST /orders holds stock in the SAME transaction as order creation, so a
// short line rolls the WHOLE checkout back — no order, no hold, no orphan reservation. Runs on the
// default (pessimistic) strategy; the optimistic path and the concurrent race are covered elsewhere.
describe('Checkout holds stock (integration, atomic order↔stock)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const server = () => app.getHttpServer();

  async function stockOf(variantId: string): Promise<{ onHand: number; reserved: number }> {
    const [row] = await db
      .select({ onHand: schema.stockLevels.quantityOnHand, reserved: schema.stockLevels.quantityReserved })
      .from(schema.stockLevels)
      .where(eq(schema.stockLevels.variantId, variantId));
    return row;
  }

  async function heldReservations(
    orderId: string,
  ): Promise<{ variantId: string; quantity: number; expiresAt: Date | null }[]> {
    return db
      .select({
        variantId: schema.reservations.variantId,
        quantity: schema.reservations.quantity,
        expiresAt: schema.reservations.expiresAt,
      })
      .from(schema.reservations)
      .where(and(eq(schema.reservations.orderId, orderId), eq(schema.reservations.status, 'HELD')));
  }

  it('checks out a two-line order when stock is sufficient (201 PENDING, reserved raised, HELD reservations)', async () => {
    const token = await newUserToken(app);
    const a = await createTestProduct(app, { priceMinor: 100_000 });
    const b = await createTestProduct(app, { priceMinor: 50_000 });
    await seedStock(app, a.variantId, 5);
    await seedStock(app, b.variantId, 5);
    await addToCart(app, token, a.variantId, 2);
    await addToCart(app, token, b.variantId, 3);

    const res = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.placedAt).not.toBeNull();
    const orderId = res.body.id as string;

    // On-hand never drops at checkout; only reserved rises (two-phase hold).
    expect(await stockOf(a.variantId)).toEqual({ onHand: 5, reserved: 2 });
    expect(await stockOf(b.variantId)).toEqual({ onHand: 5, reserved: 3 });

    const held = await heldReservations(orderId);
    expect(held).toHaveLength(2);
    const byVariant = new Map(held.map((r) => [r.variantId, r]));
    expect(byVariant.get(a.variantId)?.quantity).toBe(2);
    expect(byVariant.get(b.variantId)?.quantity).toBe(3);
    for (const r of held) {
      expect(r.expiresAt).not.toBeNull();
      expect(new Date(r.expiresAt as Date).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('holds exactly the last available units (onHand == requested → available 0)', async () => {
    const token = await newUserToken(app);
    const p = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, p.variantId, 3);
    await addToCart(app, token, p.variantId, 3);

    const res = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader()).expect(201);

    const stock = await stockOf(p.variantId);
    expect(stock).toEqual({ onHand: 3, reserved: 3 });
    expect(stock.onHand - stock.reserved).toBe(0); // available floored at 0, never negative
    expect(await heldReservations(res.body.id as string)).toHaveLength(1);
  });

  it('rolls the whole checkout back when one line is short (409, NO order persisted, no hold, no orphan reservation)', async () => {
    const token = await newUserToken(app);
    const a = await createTestProduct(app, { priceMinor: 100_000 });
    const b = await createTestProduct(app, { priceMinor: 50_000 });
    await seedStock(app, a.variantId, 5);
    await seedStock(app, b.variantId, 1); // short: the order needs 2
    await addToCart(app, token, a.variantId, 2);
    await addToCart(app, token, b.variantId, 2);

    const res = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());

    expect(res.status).toBe(409);

    // No order persisted at all — the insert rolled back with the failed hold (atomic checkout).
    const list = await request(server()).get('/orders').set(authHeader(token));
    expect(list.body.items).toEqual([]);

    // No stock held on EITHER SKU — the first line's hold rolled back with the failed one.
    expect(await stockOf(a.variantId)).toEqual({ onHand: 5, reserved: 0 });
    expect(await stockOf(b.variantId)).toEqual({ onHand: 1, reserved: 0 });

    const reservations = await db
      .select({ id: schema.reservations.id })
      .from(schema.reservations)
      .where(eq(schema.reservations.variantId, a.variantId));
    expect(reservations).toHaveLength(0);
  });
});
