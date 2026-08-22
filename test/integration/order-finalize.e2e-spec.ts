import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { FinalizeOrderUseCase } from '../../src/modules/order/application/use-cases';
import { OrderPaidEvent } from '../../src/modules/order/domain/events/order-paid.event';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// A syntactically-valid UUID no seed creates — probes the not_found path without a text→uuid 500.
const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';

// The state machine + idempotency guard that turn an at-least-once webhook into an exactly-once
// effect. Drives FinalizeOrderUseCase directly against seeded orders; stock resolution is covered in
// order-finalize-stock.e2e-spec.
describe('Order finalization (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let finalize: FinalizeOrderUseCase;

  beforeAll(async () => {
    app = await createTestApp();
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
    finalize = app.get(FinalizeOrderUseCase);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  async function seedOrder(status: 'DRAFT' | 'PENDING'): Promise<string> {
    const [row] = await db
      .insert(schema.orders)
      .values({
        userId: USER_ID,
        status,
        currency: 'VND',
        totalAmount: 100_000,
        placedAt: status === 'PENDING' ? new Date() : null,
      })
      .returning({ id: schema.orders.id });
    return row.id;
  }

  async function readOrder(id: string) {
    const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, id)).limit(1);
    return row;
  }

  it('finalizes a PENDING order to PAID: status flips, finalizedAt/paymentRef stamped, event produced once', async () => {
    const orderId = await seedOrder('PENDING');

    const result = await finalize.execute({ orderId, outcome: 'PAID', reason: 'webhook:paid', paymentRef: 'pay_1' });

    expect(result.status).toBe('finalized');
    expect(result.event).toBeInstanceOf(OrderPaidEvent);
    expect(result.event).toMatchObject({ aggregateId: orderId, paymentRef: 'pay_1' });
    const row = await readOrder(orderId);
    expect(row.status).toBe('PAID');
    expect(row.finalizedAt).not.toBeNull();
    expect(row.finalizeReason).toBe('webhook:paid');
    expect(row.paymentRef).toBe('pay_1');
  });

  it('is idempotent: re-applying the same outcome is a no-op — no state change, no second event', async () => {
    const orderId = await seedOrder('PENDING');
    await finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' });
    const firstFinalizedAt = (await readOrder(orderId)).finalizedAt;

    const again = await finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' });

    expect(again.status).toBe('noop');
    expect(again.event).toBeUndefined(); // the effect (incl. the event) fires exactly once
    expect((await readOrder(orderId)).finalizedAt).toEqual(firstFinalizedAt); // unchanged
  });

  it('never regresses: a conflicting FAILED after PAID is ignored, order stays PAID', async () => {
    const orderId = await seedOrder('PENDING');
    await finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' });

    const conflicting = await finalize.execute({ orderId, outcome: 'FAILED', reason: 'webhook:failed' });

    expect(conflicting.status).toBe('ignored');
    const row = await readOrder(orderId);
    expect(row.status).toBe('PAID'); // no regress
    expect(row.finalizeReason).toBe(null); // untouched by the ignored call (PAID never carried a reason)
  });

  it('ignores finalizing an order that is not PENDING (still DRAFT)', async () => {
    const orderId = await seedOrder('DRAFT');

    const result = await finalize.execute({ orderId, outcome: 'PAID' });

    expect(result.status).toBe('ignored');
    expect((await readOrder(orderId)).status).toBe('DRAFT');
  });

  it('returns not_found for an unknown order id', async () => {
    const result = await finalize.execute({ orderId: ABSENT_UUID, outcome: 'PAID' });

    expect(result.status).toBe('not_found');
    expect(result.order).toBeUndefined();
  });

  it('serializes concurrent finalizers via the row lock: exactly one finalized, one no-op', async () => {
    const orderId = await seedOrder('PENDING');

    const [a, b] = await Promise.all([
      finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' }),
      finalize.execute({ orderId, outcome: 'PAID', paymentRef: 'pay_1' }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['finalized', 'noop']);
    const events = [a.event, b.event].filter(Boolean);
    expect(events).toHaveLength(1); // the effect ran exactly once under contention
    expect((await readOrder(orderId)).status).toBe('PAID');
  });
});
