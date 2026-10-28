import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CHECKOUT_SAGA_ENGINE,
  CheckoutEngineUnavailableError,
  type CheckoutSagaEnginePort,
} from '../../src/modules/order/application/ports/checkout-saga-engine.port';
import {
  ORDER_INVENTORY_PARTICIPANT,
  type OrderInventoryParticipantPort,
} from '../../src/modules/order/application/ports/order-inventory-participant.port';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { OUTBOX_WRITER, type OutboxWriterPort } from '../../src/shared/messaging/outbox/outbox-writer.port';
import { authHeader } from '../setup/bearer.helper';
import { orderEventTypes } from '../setup/fixtures/checkout-saga.fixture';
import { readReservationOrder, seedStock } from '../setup/fixtures/inventory.fixture';
import {
  addToCart,
  auditLedgerInvariants,
  readOrder,
  readStock,
  seedSellableSku,
  untilOrderStatus,
} from '../setup/fixtures/order-flow.fixture';
import { createTestAdminPrincipal, createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetSagasAndDatabaseBeforeEach } from '../setup/harness';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { type InventoryServiceStub, inventoryServiceStub } from '../setup/inventory-service-stub';
import { sleep } from '../setup/sleep';

const WEBHOOK_SECRET = 'whsec_e2e_checkout_saga_try_failures_01';
const TRY_TIMEOUT_MS = 3000;
const RESERVE_WAIT_MS = 6000;
const RETRY_AFTER_SEC = '5';
const SAGA_ENV = {
  SAGA_RETRY_BASE_MS: '100',
  SAGA_RETRY_CAP_MS: '500',
};

describe('Checkout saga Try failures (integration, real Temporal, real HTTP)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let inventoryService: InventoryServiceStub;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, SAGA_ENV));
    inventoryService = await inventoryServiceStub();
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app],
    () => pool,
  );
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const server = () => app.getHttpServer();

  async function buyer(variantId: string) {
    const { user, accessToken } = await createTestPrincipal(app);
    await addToCart(app, accessToken, variantId);
    const key = idempotencyKeyHeader();
    const post = () => request(server()).post('/orders').set(authHeader(accessToken)).set(key);
    return { userId: user.id, token: accessToken, key: key['Idempotency-Key'], post };
  }

  const ordersOf = (userId: string) => db.select().from(schema.orders).where(eq(schema.orders.userId, userId));
  const keyRow = async (userId: string, key: string) =>
    (
      await db
        .select()
        .from(schema.idempotencyKeys)
        .where(and(eq(schema.idempotencyKeys.scope, `user:${userId}`), eq(schema.idempotencyKeys.key, key)))
    )[0];

  const expectUnavailable = (res: request.Response) => {
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe(RETRY_AFTER_SEC);
    // Nothing internal leaks: neither Temporal nor the Try outcome.
    expect(JSON.stringify(res.body)).not.toMatch(/temporal|timeout|abandon/i);
  };

  it('rejects an order it cannot stock, hides it from the buyer, and places a new one once restocked', async () => {
    const sku = await seedSellableSku(app, { onHand: 0 });
    const { userId, token, post } = await buyer(sku.variantId);

    const refused = await post().expect(409);

    expect(refused.body.message).toBe('Insufficient stock');
    const [rejected] = await ordersOf(userId);
    expect(rejected).toMatchObject({ status: 'REJECTED', idempotencyKey: null });
    await request(server()).get(`/orders/${rejected.id}`).set(authHeader(token)).expect(404);
    const list = await request(server()).get('/orders').set(authHeader(token)).expect(200);
    expect(list.body).toMatchObject({ items: [], total: 0 });
    const admin = (await createTestAdminPrincipal(app)).accessToken;
    const seen = await request(server()).get(`/admin/orders/${rejected.id}`).set(authHeader(admin)).expect(200);
    expect(seen.body).toMatchObject({ status: 'REJECTED', finalizeReason: 'saga:try_failed' });

    await seedStock(app, sku.variantId, 3);
    const placed = await post().expect(201);

    expect(placed.body.id).not.toBe(rejected.id);
    expect(placed.body.status).toBe('PENDING');
    expect((await auditLedgerInvariants(app)).violations).toEqual([]);
  });

  it('answers 503 within the reserve wait when the Try hangs, fences it, and places a new order on a retry', async () => {
    const sku = await seedSellableSku(app, { onHand: 5 });
    const { userId, post } = await buyer(sku.variantId);
    inventoryService.hang('try');

    const startedAt = Date.now();
    expectUnavailable(await post().timeout(RESERVE_WAIT_MS + 2000));
    expect(Date.now() - startedAt).toBeLessThan(RESERVE_WAIT_MS);
    const [{ id: orderId }] = await ordersOf(userId);
    await untilOrderStatus(app, orderId, 'REJECTED');

    expect((await readOrder(app, orderId)).finalizeReason).toBe('saga:try_timeout');
    await expect.poll(async () => (await readReservationOrder(app, orderId))?.status).toBe('FENCED');
    expect(inventoryService.calls('release')).toBeGreaterThan(0);
    const inventory = app.get<OrderInventoryParticipantPort>(ORDER_INVENTORY_PARTICIPANT);
    await expect(
      inventory.tryReserve({
        orderId,
        lines: [{ skuId: sku.variantId, quantity: 1 }],
        holdUntil: new Date(Date.now() + 60_000),
      }),
    ).resolves.toBe('CONFLICT');
    expect((await readStock(app, sku.variantId))?.quantityReserved).toBe(0);

    const placed = await post().expect(201);
    expect(placed.body.id).not.toBe(orderId);
    expect((await auditLedgerInvariants(app)).violations).toEqual([]);
  });

  it('heals a checkout the engine could not take, on a retry under the same key', async () => {
    const sku = await seedSellableSku(app, { onHand: 5 });
    const { userId, post } = await buyer(sku.variantId);
    const engine = app.get<CheckoutSagaEnginePort>(CHECKOUT_SAGA_ENGINE);
    vi.spyOn(engine, 'reserve').mockRejectedValueOnce(new CheckoutEngineUnavailableError());

    expectUnavailable(await post());
    const [stranded] = await ordersOf(userId);
    expect(stranded.status).toBe('RESERVING');
    expect((await readStock(app, sku.variantId))?.quantityReserved).toBe(0);

    const healed = await post().expect(201);

    expect(healed.body).toMatchObject({ id: stranded.id, status: 'PENDING' });
    expect(await ordersOf(userId)).toHaveLength(1);
    expect((await readStock(app, sku.variantId))?.quantityReserved).toBe(1);
  });

  it('answers 503 to a retry that meets its order just rejected, caches nothing, then places a new order', async () => {
    const sku = await seedSellableSku(app, { onHand: 5 });
    const { userId, key, post } = await buyer(sku.variantId);
    const engine = app.get<CheckoutSagaEnginePort>(CHECKOUT_SAGA_ENGINE);
    vi.spyOn(engine, 'reserve').mockRejectedValueOnce(new CheckoutEngineUnavailableError());
    expectUnavailable(await post());
    const [stranded] = await ordersOf(userId);
    // Past the Try budget, so the retry's saga can only abandon the Try and reject the order.
    await sleep(TRY_TIMEOUT_MS + 200);

    expectUnavailable(await post());

    expect(await readOrder(app, stranded.id)).toMatchObject({ status: 'REJECTED', idempotencyKey: null });
    expect(await keyRow(userId, key)).toBeUndefined();
    const placed = await post().expect(201);
    expect(placed.body.id).not.toBe(stranded.id);
    expect((await auditLedgerInvariants(app)).violations).toEqual([]);
  });

  it('answers 503 while the outbox is down, keeps the hold, and places the order once it is back', async () => {
    const sku = await seedSellableSku(app, { onHand: 5 });
    const { userId, post } = await buyer(sku.variantId);
    const outbox = app.get<OutboxWriterPort>(OUTBOX_WRITER);
    const append = vi.spyOn(outbox, 'append').mockRejectedValue(new Error('outbox unavailable'));

    expectUnavailable(await post());

    const [stranded] = await ordersOf(userId);
    expect(stranded.status).toBe('RESERVING');
    expect((await readReservationOrder(app, stranded.id))?.status).toBe('HELD');
    expect(append).toHaveBeenCalled();

    append.mockRestore();
    await untilOrderStatus(app, stranded.id, 'PENDING');
    expect(await orderEventTypes(app, stranded.id)).toEqual(['order.placed']);
    const replay = await post().expect(201);
    expect(replay.body).toMatchObject({ id: stranded.id, status: 'PENDING' });
    expect(await orderEventTypes(app, stranded.id)).toEqual(['order.placed']);
  });
});
