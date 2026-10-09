import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CheckoutSagaRunnerScheduler } from '../../src/modules/order/interface/checkout-saga-runner.scheduler';
import {
  INVENTORY_PARTICIPANT,
  type InventoryParticipant,
  type TryReserveResult,
} from '../../src/modules/product/application/public/inventory-participant.port';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/bearer.helper';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import {
  addToCart,
  auditLedgerInvariants,
  buyerWithCart,
  readOrder,
  readReservationOrder,
  readSaga,
  readStock,
  seedSellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { createTestAdminPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';

const WEBHOOK_SECRET = 'whsec_e2e_checkout_saga_try_failures_01';
const TRY_TIMEOUT_MS = 1_000;
const TRY_LOCK_TIMEOUT_MS = 500;

describe('Checkout saga, a Try that does not hold (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, {
      CHECKOUT_TRY_TIMEOUT_MS: String(TRY_TIMEOUT_MS),
      INVENTORY_TRY_LOCK_TIMEOUT_MS: String(TRY_LOCK_TIMEOUT_MS),
    }));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const server = () => app.getHttpServer();
  const placeOrder = (token: string, key: Record<string, string> = idempotencyKeyHeader()) =>
    request(server()).post('/orders').set(authHeader(token)).set(key);
  const onlyOrder = async () => {
    const [order, ...others] = await db.select().from(schema.orders);
    expect(others).toHaveLength(0);
    return order;
  };
  const heldHeaders = () =>
    db.select().from(schema.reservationOrders).where(eq(schema.reservationOrders.status, 'HELD'));

  it('refuses a cart the shelf cannot cover, hides the rejected order from the buyer and frees the key', async () => {
    const sku = await seedSellableSku(app, { onHand: 1 });
    const token = await buyerWithCart(app, sku.variantId, 2);
    const key = idempotencyKeyHeader();

    const refused = await placeOrder(token, key).expect(409);

    expect(refused.body.message).toBe('Insufficient stock');
    const rejected = await onlyOrder();
    expect(rejected).toMatchObject({ status: 'REJECTED', finalizeReason: 'try:out_of_stock' });
    expect(rejected.finalizedAt).toBeInstanceOf(Date);
    await request(server()).get(`/orders/${rejected.id}`).set(authHeader(token)).expect(404);
    expect((await request(server()).get('/orders').set(authHeader(token)).expect(200)).body.items).toEqual([]);
    const { accessToken: admin } = await createTestAdminPrincipal(app);
    const seen = await request(server()).get(`/admin/orders/${rejected.id}`).set(authHeader(admin)).expect(200);
    expect(seen.body.status).toBe('REJECTED');

    await seedStock(app, sku.variantId, 5);
    const placed = await placeOrder(token, key).expect(201);

    expect(placed.body.id).not.toBe(rejected.id);
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: 5, quantityReserved: 2 });
    await expect(auditLedgerInvariants(app, { [sku.variantId]: 5 })).resolves.toEqual({
      orders: 2,
      pending: [placed.body.id],
      violations: [],
    });
  });

  it('answers 503 once the Try outlives its timeout, fencing stock so the late Try holds nothing', async () => {
    const sku = await seedSellableSku(app, { onHand: 5 });
    const token = await buyerWithCart(app, sku.variantId, 2);
    const key = idempotencyKeyHeader();
    const participant = app.get<InventoryParticipant>(INVENTORY_PARTICIPANT);
    const tryReserve = participant.tryReserve.bind(participant);
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    let lateTry: Promise<TryReserveResult> | undefined;
    vi.spyOn(participant, 'tryReserve').mockImplementationOnce((input) => {
      lateTry = gate.then(() => tryReserve(input));
      return lateTry;
    });

    const started = Date.now();
    const unavailable = await placeOrder(token, key).expect(503);

    expect(Date.now() - started).toBeGreaterThanOrEqual(TRY_TIMEOUT_MS);
    expect(unavailable.headers['retry-after']).toMatch(/^\d+$/);
    const rejected = await onlyOrder();
    expect(rejected).toMatchObject({ status: 'REJECTED', finalizeReason: 'try:timeout' });
    expect(await readSaga(app, rejected.id)).toMatchObject({ step: 'COMPENSATED', pendingCompensations: [] });
    expect(await readReservationOrder(app, rejected.id)).toMatchObject({ status: 'FENCED' });

    openGate();

    await expect(lateTry).resolves.toMatchObject({ outcome: 'CONFLICT' });
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: 5, quantityReserved: 0 });
    expect(await heldHeaders()).toEqual([]);
    await expect(auditLedgerInvariants(app, { [sku.variantId]: 5 })).resolves.toEqual({
      orders: 1,
      pending: [],
      violations: [],
    });

    const placed = await placeOrder(token, key).expect(201);
    expect(placed.body.id).not.toBe(rejected.id);
  });

  it('answers 409 within the Try budget when a stock row stays locked, leaving no hold and no connection', async () => {
    const free = await seedSellableSku(app, { onHand: 5 });
    const locked = await seedSellableSku(app, { onHand: 5 });
    const token = await buyerWithCart(app, free.variantId, 1);
    await addToCart(app, token, locked.variantId, 1);
    const checkedOutBefore = pool.totalCount - pool.idleCount;

    const holder = await pool.connect();
    let answered: { status: number; elapsedMs: number };
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM stock_levels WHERE variant_id = $1 FOR UPDATE', [locked.variantId]);
      const started = Date.now();
      const res = await placeOrder(token);
      answered = { status: res.status, elapsedMs: Date.now() - started };
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }

    expect(answered.status).toBe(409);
    expect(answered.elapsedMs).toBeLessThan(TRY_TIMEOUT_MS + 1_000);
    const rejected = await onlyOrder();
    expect(rejected).toMatchObject({ status: 'REJECTED', finalizeReason: 'try:contended' });

    await app.get(CheckoutSagaRunnerScheduler).tick();

    expect((await readOrder(app, rejected.id)).status).toBe('REJECTED');
    expect(await heldHeaders()).toEqual([]);
    expect(await readStock(app, free.variantId)).toMatchObject({ quantityReserved: 0 });
    expect(await readStock(app, locked.variantId)).toMatchObject({ quantityReserved: 0 });
    expect(pool.totalCount - pool.idleCount).toBe(checkedOutBefore);
    await expect(auditLedgerInvariants(app, { [free.variantId]: 5, [locked.variantId]: 5 })).resolves.toEqual({
      orders: 1,
      pending: [],
      violations: [],
    });
  });
});
