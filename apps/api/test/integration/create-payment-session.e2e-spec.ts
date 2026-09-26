import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DuplicateActivePaymentError,
  PAYMENT_REPOSITORY,
  type PaymentRepositoryPort,
} from '../../src/modules/payment/application/ports/payment-repository.port';
import { Payment } from '../../src/modules/payment/domain/payment.entity';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/bearer.helper';
import { buyerWithCart, checkout, seedSellableSku } from '../setup/fixtures/order-flow.fixture';
import { newPrincipalToken } from '../setup/fixtures/principal.fixture';
import {
  closeAppAfterAll,
  createTestAppWithFakeGateway,
  createTestAppWithPool,
  resetDatabaseBeforeEach,
} from '../setup/harness';

const ABSENT_ORDER_UUID = '00000000-0000-4000-8000-000000000000';
const CONCURRENT_PAYS = 8;
const WEBHOOK_SECRET = 'whsec_e2e_create_session_reuse_secret_01';

describe('Create payment session (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const pay = (orderId: string, token: string) =>
    request(app.getHttpServer()).post(`/orders/${orderId}/pay`).set(authHeader(token));

  async function pendingOrder(quantity = 1): Promise<{ token: string; orderId: string; totalMinor: number }> {
    const sku = await seedSellableSku(app, { onHand: quantity + 5, priceMinor: 199_000 });
    const token = await buyerWithCart(app, sku.variantId, quantity);
    const res = await checkout(app, token).expect(201);
    return { token, orderId: res.body.id as string, totalMinor: res.body.totalAmountMinor as number };
  }

  const paymentsFor = (orderId: string) =>
    db.select().from(schema.payments).where(eq(schema.payments.orderId, orderId));

  it('opens one PENDING payment for the order total', async () => {
    const { token, orderId, totalMinor } = await pendingOrder(2);

    const res = await pay(orderId, token).expect(201);

    expect(res.body.paymentId).toEqual(expect.any(String));
    expect(res.body.providerSessionId).toMatch(/^cs_test_/);
    expect(res.body.redirectUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect(await paymentsFor(orderId)).toEqual([
      expect.objectContaining({
        status: 'PENDING',
        provider: 'stripe',
        amountMinor: totalMinor,
        currency: 'VND',
        providerSessionId: res.body.providerSessionId,
        providerIntentId: null,
      }),
    ]);
  });

  it("answers 404 for another buyer's order and for an unknown id", async () => {
    const { orderId } = await pendingOrder();
    const stranger = await newPrincipalToken(app);

    await pay(orderId, stranger).expect(404);
    await pay(ABSENT_ORDER_UUID, stranger).expect(404);

    expect(await paymentsFor(orderId)).toHaveLength(0);
  });

  // The offline gateway (no STRIPE_SECRET_KEY here) can never confirm a fabricated handle is still
  // open — retrieveSession always answers UNKNOWN — so a repeat pay stays refused rather than reused.
  it('refuses a second session while one is active', async () => {
    const { token, orderId } = await pendingOrder();
    await pay(orderId, token).expect(201);

    await pay(orderId, token).expect(409);

    expect(await paymentsFor(orderId)).toHaveLength(1);
  });

  // Concurrent requests all pass the read-side check; only the partial unique index can stop them.
  it('lets exactly one of several concurrent pays open a session', async () => {
    const { token, orderId } = await pendingOrder();

    const results = await Promise.all(Array.from({ length: CONCURRENT_PAYS }, () => pay(orderId, token)));

    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([201, ...Array<number>(CONCURRENT_PAYS - 1).fill(409)]);
    expect(await paymentsFor(orderId)).toHaveLength(1);
  });

  it('persists a payment amount above the int4 ceiling', async () => {
    const { orderId } = await pendingOrder();
    const payments = app.get<PaymentRepositoryPort>(PAYMENT_REPOSITORY);
    const aboveInt4Max = 2_490_000 * 863;
    expect(aboveInt4Max).toBeGreaterThan(2_147_483_647);

    const saved = await payments.create(
      Payment.create({
        orderId,
        provider: 'stripe',
        providerSessionId: 'cs_test_above_int4',
        amountMinor: aboveInt4Max,
        currency: 'VND',
      }),
    );

    expect(saved.amountMinor).toBe(aboveInt4Max);
    expect(await paymentsFor(orderId)).toEqual([expect.objectContaining({ amountMinor: aboveInt4Max })]);
  });

  it('reports a second active payment for one order as a duplicate at the unique index', async () => {
    const { orderId, totalMinor } = await pendingOrder();
    const payments = app.get<PaymentRepositoryPort>(PAYMENT_REPOSITORY);
    const session = (providerSessionId: string) =>
      Payment.create({ orderId, provider: 'stripe', providerSessionId, amountMinor: totalMinor, currency: 'VND' });
    await payments.create(session('cs_test_first'));

    await expect(payments.create(session('cs_test_second'))).rejects.toBeInstanceOf(DuplicateActivePaymentError);

    expect(await paymentsFor(orderId)).toEqual([expect.objectContaining({ providerSessionId: 'cs_test_first' })]);
  });

  it('refuses to pay an order that is no longer PENDING', async () => {
    const { token, orderId } = await pendingOrder();
    await db.update(schema.orders).set({ status: 'CANCELLED' }).where(eq(schema.orders.id, orderId));

    await pay(orderId, token).expect(409);

    expect(await paymentsFor(orderId)).toHaveLength(0);
  });
});

// A fake gateway that can actually answer "still open", which the offline Stripe adapter above never
// can — needed to exercise the reuse/retire decision a repeat pay now makes.
describe('Create payment session reuse (integration, real Postgres, fake gateway)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const pay = (orderId: string, token: string) =>
    request(app.getHttpServer()).post(`/orders/${orderId}/pay`).set(authHeader(token));

  async function pendingOrder(): Promise<{ token: string; orderId: string }> {
    const sku = await seedSellableSku(app, { onHand: 5, priceMinor: 199_000 });
    const token = await buyerWithCart(app, sku.variantId);
    const res = await checkout(app, token).expect(201);
    return { token, orderId: res.body.id as string };
  }

  const paymentsFor = (orderId: string) =>
    db.select().from(schema.payments).where(eq(schema.payments.orderId, orderId));

  it('hands back the same still-open session instead of refusing a repeat pay', async () => {
    const { token, orderId } = await pendingOrder();
    const first = await pay(orderId, token).expect(201);
    gateway.setPaymentStatus(first.body.providerSessionId as string, 'PENDING');

    const second = await pay(orderId, token).expect(201);

    expect(second.body).toEqual(first.body);
    expect(await paymentsFor(orderId)).toHaveLength(1);
  });

  it('retires a session the gateway confirms has failed and opens a fresh one', async () => {
    const { token, orderId } = await pendingOrder();
    const first = await pay(orderId, token).expect(201);
    gateway.setPaymentStatus(first.body.providerSessionId as string, 'FAILED');

    const second = await pay(orderId, token).expect(201);

    expect(second.body.providerSessionId).not.toBe(first.body.providerSessionId);
    expect(await paymentsFor(orderId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerSessionId: first.body.providerSessionId, status: 'FAILED' }),
        expect.objectContaining({ providerSessionId: second.body.providerSessionId, status: 'PENDING' }),
      ]),
    );
  });

  it('refuses rather than open a second session when the gateway already recorded the first as paid', async () => {
    const { token, orderId } = await pendingOrder();
    const first = await pay(orderId, token).expect(201);
    gateway.setPaymentStatus(first.body.providerSessionId as string, 'PAID');

    await pay(orderId, token).expect(409);

    expect(await paymentsFor(orderId)).toEqual([
      expect.objectContaining({ providerSessionId: first.body.providerSessionId, status: 'PENDING' }),
    ]);
  });
});
