import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleDB } from '../../src/database';
import * as schema from '../../src/database/schema';
import { authHeader } from '../setup/bearer.helper';
import { eventually } from '../setup/eventually';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { countHeldReservations, getStockView, seedStock } from '../setup/fixtures/inventory.fixture';
import { addToCart } from '../setup/fixtures/order-flow.fixture';
import { newPrincipalToken } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetSagasAndDatabaseBeforeEach } from '../setup/harness';

// N distinct buyers race POST /orders for the last unit(s). Each has its own user, cart, and
// Idempotency-Key, so only STOCK contends. Asserted on outcomes, not timing. The lock strategies are
// the inventory-service's to race (its `reservations-oversell`); this is the order side of losing.
const CONTENDERS = 16;

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('Checkout oversell race', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app],
    () => pool,
  );

  const server = () => app.getHttpServer();

  async function buyerFor(skuId: string, quantity: number): Promise<string> {
    const accessToken = await newPrincipalToken(app);
    await addToCart(app, accessToken, skuId, quantity);
    return accessToken;
  }

  async function race(
    onHand: number,
    contenders: number,
  ): Promise<{ variantId: string; statuses: (number | 'errored')[] }> {
    const product = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, product.variantId, onHand);
    const tokens = await Promise.all(range(contenders).map(() => buyerFor(product.variantId, 1)));

    const settled = await Promise.allSettled(
      tokens.map((token) => request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader())),
    );
    const statuses = settled.map((r) => (r.status === 'fulfilled' ? r.value.status : ('errored' as const)));
    return { variantId: product.variantId, statuses };
  }

  // A buyer answered 503 may still be RESERVING; the saga settles it either way.
  async function settledOrderStatuses(variantId: string): Promise<string[]> {
    const read = async () =>
      (
        await db
          .select({ status: schema.orders.status })
          .from(schema.orders)
          .innerJoin(schema.orderItems, eq(schema.orderItems.orderId, schema.orders.id))
          .where(eq(schema.orderItems.skuId, variantId))
      ).map((row) => row.status);
    return eventually(read, (statuses) => !statuses.includes('RESERVING'));
  }

  async function expectSoldOut(variantId: string, units: number): Promise<void> {
    // Available pinned at exactly 0, never negative, and on-hand undecremented.
    expect(await getStockView(app, variantId)).toEqual({ onHand: units, reserved: units, available: 0 });
    expect(await countHeldReservations(app, variantId)).toBe(units);

    const orders = await settledOrderStatuses(variantId);
    expect(orders.filter((status) => status === 'PENDING')).toHaveLength(units);
    expect(orders.filter((status) => status === 'REJECTED')).toHaveLength(CONTENDERS - units);
  }

  it('sells the last unit to exactly one of many buyers and refuses the rest', async () => {
    const { variantId, statuses } = await race(1, CONTENDERS);

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    // Refused cleanly, none errored: sold out, or the Try outlived its budget.
    expect(statuses.filter((s) => s === 409 || s === 503)).toHaveLength(CONTENDERS - 1);
    await expectSoldOut(variantId, 1);
  });

  it('sells K units to exactly K of more buyers, flooring available at 0', async () => {
    const K = 3;
    const { variantId, statuses } = await race(K, CONTENDERS);

    expect(statuses.filter((s) => s === 201)).toHaveLength(K);
    expect(statuses.filter((s) => s === 409 || s === 503)).toHaveLength(CONTENDERS - K);
    await expectSoldOut(variantId, K);
  });
});
