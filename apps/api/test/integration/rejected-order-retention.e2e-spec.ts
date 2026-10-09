import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { RetentionSweepRegistry } from '@jcool/platform/retention';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

const WINDOWS = {
  RETENTION_REJECTED_ORDER_DAYS: '30',
};

describe('Rejected order retention sweep (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let registry: RetentionSweepRegistry;

  const sweepNamed = (name: string) => {
    const sweep = registry.all().find((s) => s.name === name);
    if (!sweep) throw new Error(`no retention sweep named "${name}"`);
    return sweep;
  };

  const rejectedOrder = (overrides: Partial<typeof schema.orders.$inferInsert> = {}) => ({
    id: testId(),
    userId: testId(),
    status: 'REJECTED' as const,
    currency: 'VND',
    totalAmount: 100_000,
    placedAt: new Date(),
    finalizedAt: new Date(),
    finalizeReason: 'try:out_of_stock',
    ...overrides,
  });

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool(WINDOWS));
    registry = app.get(RetentionSweepRegistry);
  });

  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  it('deletes REJECTED orders finalized before the retention window', async () => {
    const oldOrderId = testId();
    const recentOrderId = testId();
    const otherId = testId();

    await db.insert(schema.orders).values([
      rejectedOrder({ id: oldOrderId, finalizedAt: daysAgo(31) }),
      rejectedOrder({ id: recentOrderId, finalizedAt: daysAgo(29) }),
      {
        id: otherId,
        userId: testId(),
        status: 'PENDING',
        currency: 'VND',
        totalAmount: 100_000,
        placedAt: new Date(),
      },
    ]);

    await db.insert(schema.orderItems).values([
      { id: testId(), orderId: oldOrderId, skuId: testId(), productName: 'A', unitPrice: 100_000, quantity: 1 },
      { id: testId(), orderId: recentOrderId, skuId: testId(), productName: 'B', unitPrice: 100_000, quantity: 1 },
      { id: testId(), orderId: otherId, skuId: testId(), productName: 'C', unitPrice: 100_000, quantity: 1 },
    ]);

    await db.insert(schema.checkoutSagas).values([
      { orderId: oldOrderId, step: 'COMPENSATED', deadlineAt: daysAgo(31), nextAttemptAt: new Date(), version: 1 },
      { orderId: recentOrderId, step: 'COMPENSATED', deadlineAt: daysAgo(29), nextAttemptAt: new Date(), version: 1 },
      { orderId: otherId, step: 'AWAITING_AUTH', deadlineAt: new Date(), nextAttemptAt: new Date(), version: 1 },
    ]);

    const deleted = await sweepNamed('order:rejected-orders').sweep(500);

    expect(deleted).toBe(1);
    const orders = await db.select({ id: schema.orders.id }).from(schema.orders);
    expect(orders.map((r) => r.id)).toEqual([recentOrderId, otherId]);

    const items = await db.select({ orderId: schema.orderItems.orderId }).from(schema.orderItems);
    expect(items.map((r) => r.orderId)).toEqual(expect.not.arrayContaining([oldOrderId]));

    const sagas = await db.select({ orderId: schema.checkoutSagas.orderId }).from(schema.checkoutSagas);
    expect(sagas.map((r) => r.orderId)).toEqual(expect.not.arrayContaining([oldOrderId]));
  });

  it('deletes no more than the batch allows', async () => {
    await db
      .insert(schema.orders)
      .values([
        rejectedOrder({ id: testId(), finalizedAt: daysAgo(31) }),
        rejectedOrder({ id: testId(), finalizedAt: daysAgo(31) }),
        rejectedOrder({ id: testId(), finalizedAt: daysAgo(31) }),
      ]);

    expect(await sweepNamed('order:rejected-orders').sweep(2)).toBe(2);
    expect(await db.select().from(schema.orders)).toHaveLength(1);
  });
});
