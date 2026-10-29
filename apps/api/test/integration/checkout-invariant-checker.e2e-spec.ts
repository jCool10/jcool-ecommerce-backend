import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PaymentOrderStatus, ReservationOrderStatus } from '@jcool/internal-contracts';
import {
  ORDER_PAYMENT_PARTICIPANT,
  type OrderPaymentParticipantPort,
} from '../../src/modules/order/application/ports/order-payment-participant.port';
import {
  RunCheckoutInvariantsUseCase,
  type CheckoutInvariantCounts,
} from '../../src/modules/order/application/use-cases';
import { CHECKOUT_INVARIANT_KINDS } from '../../src/modules/order/domain/checkout-invariants';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { eventually } from '../setup/eventually';
import { failAlways, releaseHung, sagaEngine } from '../setup/fixtures/checkout-saga.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetSagasAndDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { inventoryServiceStub } from '../setup/inventory-service-stub';
import { E2E_METRICS_TOKEN, scrapeMetrics } from '../setup/metrics.helper';
import { paymentServiceStub } from '../setup/payment-service-stub';

const PRICE = 90_000;
const CURRENCY = 'VND';
const CHECKER_ENV = {
  CHECKOUT_INVARIANT_SETTLE_SEC: '0',
  CHECKOUT_INVARIANT_BATCH_SIZE: '2',
  METRICS_TOKEN: E2E_METRICS_TOKEN,
};
const NONE = Object.fromEntries(CHECKOUT_INVARIANT_KINDS.map((kind) => [kind, 0])) as CheckoutInvariantCounts;

type OrderStatus = (typeof schema.orderStatus.enumValues)[number];
type StockHeader = ReservationOrderStatus;

interface SettledSeed {
  stock?: StockHeader;
  payment?: PaymentOrderStatus;
  /** A payment attempt: AUTHORIZED still holds money, SUCCEEDED took it. */
  attempt?: 'AUTHORIZED' | 'SUCCEEDED';
  finalizedAt?: Date;
  /** The saga's marker; an order without one predates it. */
  sagaOrder?: boolean;
  finalizeReason?: string;
}

describe('Checkout invariant checker (integration, real Postgres and Temporal)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool(CHECKER_ENV));
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app],
    () => pool,
  );
  afterEach(() => {
    releaseHung();
  });

  const check = () => app.get(RunCheckoutInvariantsUseCase).execute();

  // Straight into the orders table and the participant stubs, with no saga behind it: the checker
  // must read what is there, however it got there.
  async function seedSettled(status: OrderStatus, seed: SettledSeed = {}): Promise<string> {
    const orderId = testId();
    const finalizedAt = seed.finalizedAt ?? new Date(Date.now() - 60_000);
    const placedAt = new Date(finalizedAt.getTime() - 120_000);
    await db.insert(schema.orders).values({
      id: orderId,
      userId: testId(),
      status,
      currency: CURRENCY,
      totalAmount: PRICE,
      placedAt,
      finalizedAt,
      finalizeReason: seed.finalizeReason ?? null,
      paymentDeadlineAt: seed.sagaOrder === false ? null : new Date(placedAt.getTime() + 3_600_000),
    });
    if (seed.stock) {
      (await inventoryServiceStub()).setHeader(orderId, seed.stock);
    }
    if (seed.payment || seed.attempt) {
      (await paymentServiceStub()).setStatus(orderId, {
        header: seed.payment ?? null,
        authorizedPaymentId: seed.attempt ? testId() : null,
        hasAuthorizedAttempt: seed.attempt === 'AUTHORIZED',
        hasSucceededAttempt: seed.attempt === 'SUCCEEDED',
      });
    }
    return orderId;
  }

  it('counts each kind of broken checkout and reports it on /metrics', async () => {
    await seedSettled('EXPIRED', { stock: 'RELEASED', payment: 'CAPTURED', attempt: 'SUCCEEDED' });
    await seedSettled('PAID', { stock: 'COMMITTED', payment: 'CANCELLED' });
    await seedSettled('PAID', { stock: 'RELEASED', payment: 'CAPTURED', attempt: 'SUCCEEDED' });
    await seedSettled('CANCELLED', { stock: 'HELD', payment: 'CANCELLED' });
    // The header was cancelled, but an attempt under it still holds the money.
    await seedSettled('CANCELLED', { stock: 'RELEASED', payment: 'CANCELLED', attempt: 'AUTHORIZED' });
    const before = (await scrapeMetrics(app)).value('checkout_invariant_check_total', { result: 'violations' }) ?? 0;

    const run = await check();

    const one = Object.fromEntries(CHECKOUT_INVARIANT_KINDS.map((kind) => [kind, 1]));
    expect(run).toEqual({ result: 'violations', checked: 5, violations: one });
    const metrics = await scrapeMetrics(app);
    for (const kind of CHECKOUT_INVARIANT_KINDS) {
      expect(metrics.value('checkout_invariant_violations', { kind }), kind).toBe(1);
    }
    expect(metrics.value('checkout_invariant_check_total', { result: 'violations' })).toBe(before + 1);
  });

  it('counts a hold left under an order its Try timed out', async () => {
    await seedSettled('REJECTED', { stock: 'HELD', finalizeReason: 'saga:try_timeout' });

    await expect(check()).resolves.toMatchObject({ violations: { ...NONE, orphan_hold: 1 } });
  });

  it('leaves an order to its saga while compensation is still running', async () => {
    const orderId = await seedSettled('CANCELLED', { stock: 'HELD', payment: 'AUTHORIZED' });
    const cancel = failAlways(app.get<OrderPaymentParticipantPort>(ORDER_PAYMENT_PARTICIPANT), 'cancel', { orderId });
    const placedAt = new Date(Date.now() - 180_000);
    await sagaEngine(app).notifyAuthorized(
      {
        mode: 'lateAuthorization',
        orderId,
        userId: testId(),
        lines: [{ skuId: testId(), quantity: 1 }],
        totalMinor: PRICE,
        currency: CURRENCY,
        placedAt,
        deadlineAt: new Date(placedAt.getTime() + 3_600_000),
      },
      { paymentId: testId(), amountMinor: PRICE, currency: CURRENCY, authorizedAt: new Date().toISOString() },
    );
    await eventually(cancel.calls, (calls) => calls >= 1);
    await eventually(
      () => sagaEngine(app).runningOrderIds([orderId]),
      (running) => running.has(orderId),
    );

    await expect(check()).resolves.toEqual({ result: 'ok', checked: 0, violations: NONE });
  });

  it('reads every batch, keyed on the millisecond, whatever order the ids come in', async () => {
    // Settled in the reverse of id order, and the middle three inside one millisecond, apart only in
    // microseconds: Postgres keeps those, a JS Date cursor cannot.
    const offsetsSec = [0, 1.0001, 1.0002, 1.0003, 5.0004];
    const base = new Date(Date.now() - 60_000).toISOString();
    for (const offset of offsetsSec) {
      const orderId = await seedSettled('CANCELLED', { stock: 'HELD' });
      await pool.query('UPDATE orders SET finalized_at = $1::timestamptz - make_interval(secs => $2) WHERE id = $3', [
        base,
        offset,
        orderId,
      ]);
    }

    await expect(check()).resolves.toEqual({
      result: 'violations',
      checked: 5,
      violations: { ...NONE, orphan_hold: 5 },
    });
  });

  it('ignores an order the saga never ran', async () => {
    await seedSettled('CANCELLED', { stock: 'HELD', sagaOrder: false });

    await expect(check()).resolves.toEqual({ result: 'ok', checked: 0, violations: NONE });
  });

  it('finds nothing wrong with an order rejected before either participant heard of it', async () => {
    await seedSettled('REJECTED', { finalizeReason: 'saga:try_failed' });

    await expect(check()).resolves.toEqual({ result: 'ok', checked: 1, violations: NONE });
  });

  it('asks visibility about a full batch of orders that never had a run', async () => {
    const orderIds = Array.from({ length: 200 }, () => testId());

    await expect(sagaEngine(app).runningOrderIds(orderIds)).resolves.toEqual(new Set());
  });

  it('reports every kind at zero on clean data', async () => {
    await seedSettled('PAID', { stock: 'COMMITTED', payment: 'CAPTURED', attempt: 'SUCCEEDED' });
    await seedSettled('EXPIRED', { stock: 'RELEASED', payment: 'CANCELLED' });

    await expect(check()).resolves.toEqual({ result: 'ok', checked: 2, violations: NONE });
    const metrics = await scrapeMetrics(app);
    for (const kind of CHECKOUT_INVARIANT_KINDS) {
      expect(metrics.value('checkout_invariant_violations', { kind }), kind).toBe(0);
    }
  });
});
