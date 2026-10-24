import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { authHeader } from '../setup/bearer.helper';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import {
  addToCart,
  buyerWithCart,
  checkout,
  driveToPaid,
  openSession,
  seedSellableSku,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { createTestAdminPrincipal, newPrincipalToken } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetSagasAndDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

// The public checkout contract, pinned while the implementation behind it changes. Only status codes
// and the fields a client relies on are asserted, so an added field never breaks it.

const WEBHOOK_SECRET = 'whsec_e2e_checkout_contract_secret_01';
const PRICE = 125_000;
const ABSENT_ID = testId();

describe('Checkout contract (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let sku: SellableSku;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app],
    () => pool,
  );

  const server = () => app.getHttpServer();
  const cancel = (token: string, orderId: string) =>
    request(server()).post(`/orders/${orderId}/cancel`).set(authHeader(token));
  const adminCancel = (token: string, orderId: string) =>
    request(server()).post(`/admin/orders/${orderId}/cancel`).set(authHeader(token));

  async function placed(quantity = 1): Promise<{ token: string; orderId: string }> {
    sku = await seedSellableSku(app, { onHand: 20, priceMinor: PRICE });
    const token = await buyerWithCart(app, sku.variantId, quantity);
    const res = await checkout(app, token).expect(201);
    return { token, orderId: res.body.id as string };
  }

  describe('POST /orders', () => {
    it('answers 201 with the placed order', async () => {
      sku = await seedSellableSku(app, { onHand: 5, priceMinor: PRICE });
      const token = await buyerWithCart(app, sku.variantId, 2);

      const res = await checkout(app, token).expect(201);

      expect(res.body).toMatchObject({
        id: expect.any(String),
        status: 'PENDING',
        currency: 'VND',
        totalAmountMinor: 2 * PRICE,
        placedAt: expect.any(String),
        items: [{ skuId: sku.variantId, quantity: 2, unitPriceMinor: PRICE, lineTotalMinor: 2 * PRICE }],
      });
    });

    it('answers 400 for an empty cart and for a missing Idempotency-Key', async () => {
      const token = await newPrincipalToken(app);
      await checkout(app, token).expect(400);

      sku = await seedSellableSku(app, { onHand: 5 });
      await addToCart(app, token, sku.variantId);
      await request(server()).post('/orders').set(authHeader(token)).expect(400);
    });

    it('answers 409 Insufficient stock without revealing quantities', async () => {
      sku = await seedSellableSku(app, { onHand: 1 });
      const token = await buyerWithCart(app, sku.variantId, 3);

      const res = await checkout(app, token).expect(409);

      expect(res.body.message).toBe('Insufficient stock');
      expect(JSON.stringify(res.body.message)).not.toMatch(/\d/);
    });

    it('answers 409 once the buyer already has three orders awaiting payment', async () => {
      sku = await seedSellableSku(app, { onHand: 20 });
      const token = await buyerWithCart(app, sku.variantId);
      for (let i = 0; i < 3; i++) await checkout(app, token).expect(201);

      await checkout(app, token).expect(409);
    });

    it('replays the same order for the same key, and answers 422 when the key is reused with another body', async () => {
      sku = await seedSellableSku(app, { onHand: 5 });
      const token = await buyerWithCart(app, sku.variantId);
      const key = randomUUID();
      const post = () => request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader(key));

      const first = await post().expect(201);
      const replay = await post().expect(201);
      expect(replay.body.id).toBe(first.body.id);

      await post().send({ tampered: true }).expect(422);
    });
  });

  describe('POST /orders/:id/pay', () => {
    it('answers 201 with a payment session', async () => {
      const { token, orderId } = await placed();

      const res = await openSession(app, token, orderId).expect(201);

      expect(res.body).toMatchObject({ paymentId: expect.any(String), providerSessionId: expect.any(String) });
      expect(res.body.redirectUrl ?? res.body.clientSecret).toEqual(expect.any(String));
    });

    it("answers 404 for another buyer's order and for an unknown id", async () => {
      const { orderId } = await placed();
      const stranger = await newPrincipalToken(app);

      await openSession(app, stranger, orderId).expect(404);
      await openSession(app, stranger, ABSENT_ID).expect(404);
    });

    it('answers 409 for a cancelled order', async () => {
      const { token, orderId } = await placed();
      await cancel(token, orderId).expect(200);

      await openSession(app, token, orderId).expect(409);
    });
  });

  describe('POST /orders/:id/cancel', () => {
    it('answers 200 with the cancelled order, and 200 again on a repeat', async () => {
      const { token, orderId } = await placed();

      const first = await cancel(token, orderId).expect(200);
      expect(first.body).toMatchObject({ id: orderId, status: 'CANCELLED' });

      const again = await cancel(token, orderId).expect(200);
      expect(again.body).toMatchObject({ id: orderId, status: 'CANCELLED' });
    });

    it("answers 404 for another buyer's order", async () => {
      const { orderId } = await placed();

      await cancel(await newPrincipalToken(app), orderId).expect(404);
    });

    it('answers 409 for a paid order', async () => {
      const { token, orderId } = await placed();
      await driveToPaid(app, token, orderId);

      await cancel(token, orderId).expect(409);
    });
  });

  describe('POST /admin/orders/:id/cancel', () => {
    it('answers 200 with the cancelled order, and 404 for an unknown id', async () => {
      const { orderId } = await placed();
      const admin = (await createTestAdminPrincipal(app)).accessToken;

      const res = await adminCancel(admin, orderId).expect(200);
      expect(res.body).toMatchObject({ id: orderId, status: 'CANCELLED' });

      await adminCancel(admin, ABSENT_ID).expect(404);
    });
  });
});
