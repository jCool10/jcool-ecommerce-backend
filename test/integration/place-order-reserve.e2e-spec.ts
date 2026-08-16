import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/auth.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// Single-thread proof that placing an order holds stock in the SAME transaction as the
// DRAFT → PENDING flip: enough stock → PENDING + HELD reservations; a short line rolls
// the WHOLE placement back (order stays DRAFT, no stock held, no orphan reservation).
// The default lock strategy (pessimistic) drives this; the optimistic path and the
// concurrent "exactly one wins" race are covered separately (repo + concurrency specs).
describe('Place order + reserve stock (integration, atomic order↔stock)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    app = await createTestApp();
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  const server = () => app.getHttpServer();

  async function newUser(): Promise<string> {
    const { accessToken } = await createTestUser(app);
    return accessToken;
  }

  async function addToCart(token: string, skuId: string, quantity: number): Promise<void> {
    await request(server()).post('/cart/items').set(authHeader(token)).send({ skuId, quantity }).expect(200);
  }

  async function createDraft(token: string): Promise<string> {
    const created = await request(server()).post('/orders').set(authHeader(token)).expect(201);
    return created.body.id;
  }

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

  it('places a two-line order when stock is sufficient (200 PENDING, reserved raised, HELD reservations)', async () => {
    const token = await newUser();
    const a = await createTestProduct(app, { priceMinor: 100_000 });
    const b = await createTestProduct(app, { priceMinor: 50_000 });
    await seedStock(app, a.variantId, 5);
    await seedStock(app, b.variantId, 5);
    await addToCart(token, a.variantId, 2);
    await addToCart(token, b.variantId, 3);
    const orderId = await createDraft(token);

    const res = await request(server()).post(`/orders/${orderId}/place`).set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.placedAt).not.toBeNull();

    // On-hand never drops at placement; only reserved rises (two-phase hold).
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
    const token = await newUser();
    const p = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, p.variantId, 3);
    await addToCart(token, p.variantId, 3);
    const orderId = await createDraft(token);

    await request(server()).post(`/orders/${orderId}/place`).set(authHeader(token)).expect(200);

    const stock = await stockOf(p.variantId);
    expect(stock).toEqual({ onHand: 3, reserved: 3 });
    expect(stock.onHand - stock.reserved).toBe(0); // available floored at 0, never negative
    expect(await heldReservations(orderId)).toHaveLength(1);
  });

  it('rolls the whole placement back when one line is short (409, order stays DRAFT, no hold, no orphan reservation)', async () => {
    const token = await newUser();
    const a = await createTestProduct(app, { priceMinor: 100_000 });
    const b = await createTestProduct(app, { priceMinor: 50_000 });
    await seedStock(app, a.variantId, 5); // plenty
    await seedStock(app, b.variantId, 1); // short: the order needs 2
    await addToCart(token, a.variantId, 2);
    await addToCart(token, b.variantId, 2);
    const orderId = await createDraft(token);

    const res = await request(server()).post(`/orders/${orderId}/place`).set(authHeader(token));

    expect(res.status).toBe(409);

    // Order untouched.
    const after = await request(server()).get(`/orders/${orderId}`).set(authHeader(token));
    expect(after.body.status).toBe('DRAFT');
    expect(after.body.placedAt).toBeNull();

    // No stock held on EITHER SKU — the first line's hold rolled back with the failed one.
    expect(await stockOf(a.variantId)).toEqual({ onHand: 5, reserved: 0 });
    expect(await stockOf(b.variantId)).toEqual({ onHand: 1, reserved: 0 });

    // No orphan reservation rows for the order.
    const orphans = await db
      .select({ id: schema.reservations.id })
      .from(schema.reservations)
      .where(eq(schema.reservations.orderId, orderId));
    expect(orphans).toHaveLength(0);
  });
});
