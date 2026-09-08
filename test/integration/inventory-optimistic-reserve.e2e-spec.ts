import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import {
  STOCK_REPOSITORY,
  type ReserveLine,
  type StockRepositoryPort,
} from '../../src/modules/inventory/application/ports/stock-repository.port';
import { InsufficientStockError } from '../../src/modules/inventory/domain/errors/insufficient-stock.error';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// Fixed, valid UUIDs — variant_id / order_id are uuid columns.
const SKU_A = '11111111-1111-4111-8111-111111111111';
const SKU_B = '22222222-2222-4222-8222-222222222222';
const ORDER_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORDER_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// One-thread behavior of the optimistic (version CAS + retry) reserve over real Postgres. The CAS
// never loses here because there is a single caller, so version contention and its
// ReservationConflictError exhaustion belong to inventory-optimistic-contention.e2e-spec.ts.
describe('Inventory optimistic reserve (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let repo: StockRepositoryPort;

  beforeAll(async () => {
    app = await createTestApp();
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
    repo = app.get<StockRepositoryPort>(STOCK_REPOSITORY);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  // Reserve inside a transaction, mirroring how place-order will call the port. A thrown
  // error rolls the whole unit of work back.
  async function reserve(orderId: string, lines: ReserveLine[]): Promise<void> {
    await db.transaction(async (tx) => {
      await repo.reserveOptimistic(tx, orderId, lines);
    });
  }

  async function readStock(variantId: string) {
    const [row] = await db.select().from(schema.stockLevels).where(eq(schema.stockLevels.variantId, variantId));
    return row;
  }

  async function reservationsFor(orderId: string, variantId: string) {
    return db
      .select()
      .from(schema.reservations)
      .where(and(eq(schema.reservations.orderId, orderId), eq(schema.reservations.variantId, variantId)));
  }

  it('holds stock when the CAS wins: reserved += qty, version bumped, one HELD row', async () => {
    await seedStock(app, SKU_A, 10);

    await reserve(ORDER_1, [{ variantId: SKU_A, quantity: 3 }]);

    const stock = await readStock(SKU_A);
    expect(stock.quantityReserved).toBe(3);
    expect(stock.quantityOnHand - stock.quantityReserved).toBe(7);
    expect(stock.version).toBe(1);

    const rows = await reservationsFor(ORDER_1, SKU_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('HELD');
    expect(rows[0].quantity).toBe(3);
    expect(rows[0].expiresAt).not.toBeNull();
    expect(rows[0].expiresAt!.getTime()).toBeGreaterThan(Date.now()); // TTL stamped ahead
  });

  it('holds the last units exactly: onHand=5, reserve 5 → available 0, HELD', async () => {
    await seedStock(app, SKU_A, 5);

    await reserve(ORDER_1, [{ variantId: SKU_A, quantity: 5 }]);

    const stock = await readStock(SKU_A);
    expect(stock.quantityReserved).toBe(5);
    expect(stock.quantityOnHand - stock.quantityReserved).toBe(0);
    expect((await reservationsFor(ORDER_1, SKU_A))[0].status).toBe('HELD');
  });

  it('throws InsufficientStockError and rolls back when short (DB unchanged, no retry)', async () => {
    await seedStock(app, SKU_A, 2);

    // A real shortfall fails the available guard in the CAS WHERE; the re-read confirms the
    // shortfall and throws immediately — no retry, no backoff.
    await expect(reserve(ORDER_1, [{ variantId: SKU_A, quantity: 3 }])).rejects.toMatchObject({
      name: 'InsufficientStockError',
      requested: 3,
      available: 2,
    });

    const stock = await readStock(SKU_A);
    expect(stock.quantityReserved).toBe(0);
    expect(stock.version).toBe(0);
    expect(await reservationsFor(ORDER_1, SKU_A)).toHaveLength(0);
  });

  it('throws with available 0 when the SKU has no stock row', async () => {
    await expect(reserve(ORDER_1, [{ variantId: SKU_A, quantity: 1 }])).rejects.toBeInstanceOf(InsufficientStockError);
  });

  it('is idempotent per (order, SKU): a repeat hold does not double-count', async () => {
    await seedStock(app, SKU_A, 10);

    await reserve(ORDER_1, [{ variantId: SKU_A, quantity: 3 }]);
    await reserve(ORDER_1, [{ variantId: SKU_A, quantity: 3 }]); // same order + SKU again

    const stock = await readStock(SKU_A);
    expect(stock.quantityReserved).toBe(3); // not 6
    expect(stock.version).toBe(1); // not bumped a second time
    expect(await reservationsFor(ORDER_1, SKU_A)).toHaveLength(1);
  });

  it('bumps version by one on every successful hold (CAS pivots on version)', async () => {
    await seedStock(app, SKU_A, 10);

    await reserve(ORDER_1, [{ variantId: SKU_A, quantity: 2 }]);
    await reserve(ORDER_2, [{ variantId: SKU_A, quantity: 2 }]);

    const stock = await readStock(SKU_A);
    expect(stock.quantityReserved).toBe(4);
    expect(stock.version).toBe(2); // one increment per winning CAS
  });

  it('holds multiple lines of one order regardless of input order', async () => {
    await seedStock(app, SKU_A, 5);
    await seedStock(app, SKU_B, 5);

    // Deliberately out of variantId order — the repo sorts before writing.
    await reserve(ORDER_1, [
      { variantId: SKU_B, quantity: 2 },
      { variantId: SKU_A, quantity: 1 },
    ]);

    expect((await readStock(SKU_A)).quantityReserved).toBe(1);
    expect((await readStock(SKU_B)).quantityReserved).toBe(2);
    expect(await reservationsFor(ORDER_1, SKU_A)).toHaveLength(1);
    expect(await reservationsFor(ORDER_1, SKU_B)).toHaveLength(1);
  });

  it('is all-or-nothing: a short later line rolls back the whole multi-line hold', async () => {
    await seedStock(app, SKU_A, 5);
    await seedStock(app, SKU_B, 1);

    await expect(
      reserve(ORDER_1, [
        { variantId: SKU_A, quantity: 2 },
        { variantId: SKU_B, quantity: 3 }, // short → throws
      ]),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    expect((await readStock(SKU_A)).quantityReserved).toBe(0); // first line's hold undone
    expect(await reservationsFor(ORDER_1, SKU_A)).toHaveLength(0);
  });
});
