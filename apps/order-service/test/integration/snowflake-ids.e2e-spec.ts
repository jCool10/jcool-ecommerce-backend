import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { decode } from '@jcool/id-codec';
import { authHeader } from '../setup/bearer.helper';
import { addToCart, checkout, seedSellableSku } from '../setup/fixtures/order-flow.fixture';
import { createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { STUB_NODE_ID, idServiceStub, testId } from '../setup/id-service-stub';

describe('Snowflake ids (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);
  afterEach(async () => (await idServiceStub()).reset());

  // The stub's node, not just a routable id: an id minted anywhere but the id-service fails here.
  const expectMintedIds = async (sql: string, params: unknown[] = []): Promise<void> => {
    const { rows } = await pool.query<{ id: string }>(sql, params);
    expect(rows.length).toBeGreaterThan(0);
    for (const { id } of rows) expect(decode(id).nodeId, id).toBe(STUB_NODE_ID);
  };

  it('mints the order and everything under it through the id-service', async () => {
    const sku = await seedSellableSku(app, { onHand: 5 });
    const { accessToken } = await createTestPrincipal(app);

    await addToCart(app, accessToken, sku.variantId, 2);
    const order = await checkout(app, accessToken).expect(201);
    const orderId = order.body.id as string;

    expect(decode(orderId).nodeId, orderId).toBe(STUB_NODE_ID);
    await expectMintedIds('SELECT id FROM order_items WHERE order_id = $1', [orderId]);
    await expectMintedIds('SELECT id FROM idempotency_keys');
    await expectMintedIds('SELECT id FROM outbox');
  });

  it('refuses a uuid where an id belongs, and 404s a routable id nobody minted', async () => {
    const { accessToken } = await createTestPrincipal(app);

    await request(app.getHttpServer()).get(`/orders/${randomUUID()}`).set(authHeader(accessToken)).expect(400);
    await request(app.getHttpServer()).get(`/orders/${testId()}`).set(authHeader(accessToken)).expect(404);
  });

  it('answers 503 and writes nothing when the id service cannot mint', async () => {
    const sku = await seedSellableSku(app, { onHand: 5 });
    const { accessToken } = await createTestPrincipal(app);
    await addToCart(app, accessToken, sku.variantId, 1);
    (await idServiceStub()).fail(503);

    await checkout(app, accessToken).expect(503);

    const { rows } = await pool.query('SELECT 1 FROM orders');
    expect(rows).toEqual([]);
  });
});
