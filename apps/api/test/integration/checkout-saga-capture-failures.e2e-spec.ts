import type { INestApplication } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { ReleaseLapsedHoldsUseCase } from '../../src/modules/product/application/stock/release-lapsed-holds.use-case';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { drainDomainEvents } from '../setup/domain-events';
import {
  auditLedgerInvariants,
  authorizeAndRelay,
  placeAndOpenSession,
  postAuthorizationWebhook,
  readOrder,
  readPayment,
  readReservationOrder,
  readSaga,
  readStock,
  runSagaUntilSettled,
  seedSellableSku,
  type OpenOrder,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';

const WEBHOOK_SECRET = 'whsec_e2e_checkout_saga_capture_failures_01';
const ON_HAND = 5;

describe('Checkout saga, capture and void failures (integration, real Postgres, real HMAC)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;
  let sku: SellableSku;

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  beforeEach(async () => {
    sku = await seedSellableSku(app, { onHand: ON_HAND });
  });

  /** The hold is recorded first, so a fault set between the two lands on the saga's own call. */
  async function authorizeThen(order: OpenOrder, fault: (intentId: string) => void): Promise<string> {
    const intentId = gateway.authorize(order.sessionId);
    await postAuthorizationWebhook(app, gateway, order);
    fault(intentId);
    await drainDomainEvents(app);
    return intentId;
  }

  async function expectPaidWithoutCompensation(order: OpenOrder, intentId: string): Promise<void> {
    expect((await readOrder(app, order.orderId)).status).toBe('PAID');
    expect(await readSaga(app, order.orderId)).toMatchObject({ step: 'COMPLETED', pendingCompensations: [] });
    expect((await readPayment(app, order.orderId)).status).toBe('SUCCEEDED');
    expect(gateway.captureCalls(intentId)).toBe(1);
    expect(gateway.wasVoided(intentId)).toBe(false);
  }

  const expectLedgerSettled = () =>
    expect(auditLedgerInvariants(app, { [sku.variantId]: ON_HAND })).resolves.toEqual({
      orders: 1,
      pending: [],
      violations: [],
    });

  describe('a capture with no definite answer is retried, never compensated', () => {
    it('resends a capture that timed out under the same key', async () => {
      const order = await placeAndOpenSession(app, sku);
      const intentId = await authorizeThen(order, (id) => gateway.failCapture(id, 'timeout'));
      const { stripeKeyGen } = await readPayment(app, order.orderId);
      expect(await readSaga(app, order.orderId)).toMatchObject({ step: 'CAPTURING', lastError: expect.any(String) });

      await runSagaUntilSettled(app, order.orderId);

      const [first, retry] = gateway.requestKeys(intentId);
      expect(retry).toBe(first);
      expect((await readPayment(app, order.orderId)).stripeKeyGen).toBe(stripeKeyGen);
      await expectPaidWithoutCompensation(order, intentId);
    });

    it('resends a capture refused in flight under the same key', async () => {
      const order = await placeAndOpenSession(app, sku);
      const intentId = await authorizeThen(order, (id) => gateway.failCapture(id, 'idempotency_in_flight'));
      expect((await readSaga(app, order.orderId)).step).toBe('CAPTURING');

      await runSagaUntilSettled(app, order.orderId);

      const [first, retry] = gateway.requestKeys(intentId);
      expect(retry).toBe(first);
      await expectPaidWithoutCompensation(order, intentId);
    });

    // Stripe replays a stored 500 for every resend of its key, so only a fresh key can reach the hold.
    it('rotates the key after a 500 that left the hold capturable, and captures once under the new one', async () => {
      const order = await placeAndOpenSession(app, sku);
      const { stripeKeyGen } = await readPayment(app, order.orderId);
      const intentId = await authorizeThen(order, (id) => gateway.failCapture(id, 'server_error'));
      expect((await readSaga(app, order.orderId)).step).toBe('CAPTURING');
      expect((await readPayment(app, order.orderId)).stripeKeyGen).toBe(stripeKeyGen + 1);

      await runSagaUntilSettled(app, order.orderId);

      const [first, retry] = gateway.requestKeys(intentId);
      expect(retry).not.toBe(first);
      await expectPaidWithoutCompensation(order, intentId);
    });

    it('reads a 500 after the capture applied as captured, without a second call or a new key', async () => {
      const order = await placeAndOpenSession(app, sku);
      const { stripeKeyGen } = await readPayment(app, order.orderId);

      const intentId = await authorizeThen(order, (id) => gateway.failCapture(id, 'applied_then_500'));

      expect(gateway.requestKeys(intentId)).toHaveLength(1);
      expect((await readPayment(app, order.orderId)).stripeKeyGen).toBe(stripeKeyGen);
      await expectPaidWithoutCompensation(order, intentId);
    });
  });

  it('fails the order and restocks its committed units when the hold expired before the capture', async () => {
    const order = await placeAndOpenSession(app, sku, 2);

    const intentId = await authorizeThen(order, (id) => gateway.failCapture(id, 'expired'));

    expect(await readOrder(app, order.orderId)).toMatchObject({
      status: 'FAILED',
      finalizeReason: 'payment:not_capturable',
    });
    expect(await readSaga(app, order.orderId)).toMatchObject({ step: 'COMPENSATED', pendingCompensations: [] });
    expect(await readReservationOrder(app, order.orderId)).toMatchObject({ status: 'RESTOCKED' });
    expect((await readPayment(app, order.orderId)).status).toBe('FAILED');
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: ON_HAND, quantityReserved: 0 });
    expect(gateway.captureCalls(intentId)).toBe(0);
    await expectLedgerSettled();
  });

  describe('a hold the stock side gave up on is voided, never captured', () => {
    async function sweepHold(orderId: string): Promise<void> {
      await db
        .update(schema.reservationOrders)
        .set({ holdUntil: sql`now() - interval '1 second'` })
        .where(eq(schema.reservationOrders.orderId, orderId));
      await app.get(ReleaseLapsedHoldsUseCase).execute({ batchSize: 10 });
    }

    it('fails the order when its hold was swept before the commit', async () => {
      const order = await placeAndOpenSession(app, sku);
      await sweepHold(order.orderId);

      const intentId = await authorizeThen(order, () => undefined);

      expect(await readOrder(app, order.orderId)).toMatchObject({
        status: 'FAILED',
        finalizeReason: 'stock:commit_conflict',
      });
      expect(await readSaga(app, order.orderId)).toMatchObject({ step: 'COMPENSATED', pendingCompensations: [] });
      expect(await readReservationOrder(app, order.orderId)).toMatchObject({ status: 'RELEASED' });
      expect((await readPayment(app, order.orderId)).status).toBe('VOIDED');
      expect(gateway.wasVoided(intentId)).toBe(true);
      expect(gateway.captureCalls(intentId)).toBe(0);
      await expectLedgerSettled();
    });

    it('keeps compensating through a void that 500s, then voids under a rotated key', async () => {
      const order = await placeAndOpenSession(app, sku);
      await sweepHold(order.orderId);

      const intentId = await authorizeThen(order, (id) => gateway.failVoid(id, 'server_error'));

      expect((await readOrder(app, order.orderId)).status).toBe('FAILED');
      const saga = await readSaga(app, order.orderId);
      expect(saga).toMatchObject({ step: 'COMPENSATING', pendingCompensations: ['CANCEL_PAYMENT'] });
      expect(saga.lastError).toEqual(expect.any(String));
      expect(gateway.wasVoided(intentId)).toBe(false);

      await runSagaUntilSettled(app, order.orderId);

      const [first, retry] = gateway.requestKeys(intentId);
      expect(retry).not.toBe(first);
      expect(gateway.wasVoided(intentId)).toBe(true);
      expect((await readPayment(app, order.orderId)).status).toBe('VOIDED');
      expect(gateway.captureCalls(intentId)).toBe(0);
      await expectLedgerSettled();
    });
  });

  // The payment side refuses a hold that differs from the money it opened the session for, so the
  // order's own check is only reachable when the two disagree on the amount in the first place.
  it("fails an order whose authorization reports a total that is not the order's, voiding the hold", async () => {
    const order = await placeAndOpenSession(app, sku);
    const drifted = order.charge.amountMinor! - 1;
    await db
      .update(schema.paymentOrders)
      .set({ amountMinor: drifted })
      .where(eq(schema.paymentOrders.orderId, order.orderId));
    await db.update(schema.payments).set({ amountMinor: drifted }).where(eq(schema.payments.orderId, order.orderId));

    const { intentId } = await authorizeAndRelay(app, gateway, order, { held: { amountMinor: drifted } });

    expect(await readOrder(app, order.orderId)).toMatchObject({
      status: 'FAILED',
      finalizeReason: 'payment:amount_mismatch',
    });
    expect(await readSaga(app, order.orderId)).toMatchObject({ step: 'COMPENSATED', pendingCompensations: [] });
    expect(await readReservationOrder(app, order.orderId)).toMatchObject({ status: 'RELEASED' });
    expect(gateway.wasVoided(intentId)).toBe(true);
    expect(gateway.captureCalls(intentId)).toBe(0);
  });
});
