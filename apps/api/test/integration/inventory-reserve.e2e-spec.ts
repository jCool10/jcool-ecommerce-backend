import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  STOCK_REPOSITORY,
  type ReserveLine,
  type StockRepositoryPort,
} from '../../src/modules/inventory/application/ports/stock-repository.port';
import { InsufficientStockError } from '../../src/modules/inventory/domain/errors/insufficient-stock.error';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { readStock, reservationsFor } from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

const SKU_A = '11111111-1111-4111-8111-111111111111';
const SKU_B = '22222222-2222-4222-8222-222222222222';
const ORDER_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORDER_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// Single-caller contract of both strategies. Races live in checkout-oversell and the
// inventory-optimistic-* and inventory-mixed-strategy suites.
describe('Inventory reserve (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let repo: StockRepositoryPort;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
    repo = app.get<StockRepositoryPort>(STOCK_REPOSITORY);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  describe.each(['reservePessimistic', 'reserveOptimistic'] as const)('%s', (method) => {
    const reserve = (orderId: string, lines: ReserveLine[]): Promise<void> =>
      db.transaction((tx) => repo[method](tx, orderId, lines));

    it('holds stock for each order and bumps the version once per hold', async () => {
      await seedStock(app, SKU_A, 10);

      await reserve(ORDER_1, [{ variantId: SKU_A, quantity: 3 }]);
      await reserve(ORDER_2, [{ variantId: SKU_A, quantity: 2 }]);

      expect(await readStock(app, SKU_A)).toMatchObject({ quantityOnHand: 10, quantityReserved: 5, version: 2 });
      const [held] = await reservationsFor(app, ORDER_1, SKU_A);
      expect(held).toMatchObject({ status: 'HELD', quantity: 3 });
      expect(held.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it('refuses a shortfall and changes nothing', async () => {
      await seedStock(app, SKU_A, 2);

      await expect(reserve(ORDER_1, [{ variantId: SKU_A, quantity: 3 }])).rejects.toMatchObject({
        name: 'InsufficientStockError',
        requested: 3,
        available: 2,
      });

      expect(await readStock(app, SKU_A)).toMatchObject({ quantityReserved: 0, version: 0 });
      expect(await reservationsFor(app, ORDER_1, SKU_A)).toHaveLength(0);
    });

    // Creating a SKU writes no stock row, and the cart does not check stock, so checkout reaches this.
    it('refuses a SKU that has no stock row', async () => {
      await expect(reserve(ORDER_1, [{ variantId: SKU_A, quantity: 1 }])).rejects.toMatchObject({
        name: 'InsufficientStockError',
        requested: 1,
        available: 0,
      });
    });

    it('holds once when the same order reserves the same SKU again', async () => {
      await seedStock(app, SKU_A, 10);

      await reserve(ORDER_1, [{ variantId: SKU_A, quantity: 3 }]);
      await reserve(ORDER_1, [{ variantId: SKU_A, quantity: 3 }]);

      expect(await readStock(app, SKU_A)).toMatchObject({ quantityReserved: 3, version: 1 });
      expect(await reservationsFor(app, ORDER_1, SKU_A)).toHaveLength(1);
    });

    it('holds every line of a multi-SKU order', async () => {
      await seedStock(app, SKU_A, 5);
      await seedStock(app, SKU_B, 5);

      await reserve(ORDER_1, [
        { variantId: SKU_B, quantity: 2 },
        { variantId: SKU_A, quantity: 1 },
      ]);

      expect((await readStock(app, SKU_A)).quantityReserved).toBe(1);
      expect((await readStock(app, SKU_B)).quantityReserved).toBe(2);
      expect(await reservationsFor(app, ORDER_1)).toHaveLength(2);
    });

    it('rolls back every line when a later line is short', async () => {
      await seedStock(app, SKU_A, 5);
      await seedStock(app, SKU_B, 1);

      await expect(
        reserve(ORDER_1, [
          { variantId: SKU_A, quantity: 2 },
          { variantId: SKU_B, quantity: 3 },
        ]),
      ).rejects.toBeInstanceOf(InsufficientStockError);

      expect((await readStock(app, SKU_A)).quantityReserved).toBe(0);
      expect(await reservationsFor(app, ORDER_1)).toHaveLength(0);
    });
  });

  it('refuses a direct write that reserves more than is on hand', async () => {
    await seedStock(app, SKU_A, 2);

    // Raw pg: Drizzle moves the constraint name into `.cause`.
    await expect(
      pool.query('UPDATE stock_levels SET quantity_reserved = 3 WHERE variant_id = $1', [SKU_A]),
    ).rejects.toThrow(/ck_stock_no_oversell/);
  });
});
