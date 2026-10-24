import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ORDER_INVENTORY_PARTICIPANT,
  type OrderInventoryParticipantPort,
} from '../../src/modules/order/application/ports/order-inventory-participant.port';
import {
  ORDER_PAYMENT_PARTICIPANT,
  type OrderPaymentParticipantPort,
} from '../../src/modules/order/application/ports/order-payment-participant.port';
import { stateQuery } from '../../src/modules/order/infrastructure/temporal/checkout-saga.contract';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { eventually } from '../setup/eventually';
import {
  holdCalls,
  queueForgedAuthorization,
  relayAuthorization,
  sagaHandle,
  untilSagaQuiet,
} from '../setup/fixtures/checkout-saga.fixture';
import { readReservationOrder } from '../setup/fixtures/inventory.fixture';
import {
  auditLedgerInvariants,
  authorizeSession,
  buyerWithCart,
  checkout,
  openSession,
  readOrder,
  readPaymentOrder,
  readStock,
  reservationsFor,
  seedSellableSku,
  untilOrderStatus,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetSagasAndDatabaseBeforeEach } from '../setup/harness';

const WEBHOOK_SECRET = 'whsec_e2e_checkout_saga_capture_failures_01';
const PRICE = 70_000;
const ON_HAND = 5;
const SAGA_ENV = { SAGA_RETRY_BASE_MS: '100', SAGA_RETRY_CAP_MS: '500' };

describe('Checkout saga capture failures (integration, real Temporal, fake Stripe)', () => {
  let app: INestApplication;
  let pool: Pool;
  let gateway: FakeSignerGatewayAdapter;

  beforeAll(async () => {
    ({ app, pool, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, SAGA_ENV));
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app],
    () => pool,
  );
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const inventory = () => app.get<OrderInventoryParticipantPort>(ORDER_INVENTORY_PARTICIPANT);
  const payment = () => app.get<OrderPaymentParticipantPort>(ORDER_PAYMENT_PARTICIPANT);

  async function placedWithSession(): Promise<{
    sku: SellableSku;
    orderId: string;
    sessionId: string;
    paymentId: string;
  }> {
    const sku = await seedSellableSku(app, { onHand: ON_HAND, priceMinor: PRICE });
    const token = await buyerWithCart(app, sku.variantId);
    const orderId = (await checkout(app, token).expect(201)).body.id as string;
    const pay = await openSession(app, token, orderId).expect(201);
    return {
      sku,
      orderId,
      sessionId: pay.body.providerSessionId as string,
      paymentId: pay.body.paymentId as string,
    };
  }

  const forged = (orderId: string, paymentId: string, amountMinor = PRICE) => ({
    orderId,
    paymentId,
    amountMinor,
    currency: 'VND',
    authorizedAt: new Date().toISOString(),
  });

  const expectStillWaiting = async (orderId: string) => {
    await untilSagaQuiet(app, orderId);
    expect((await sagaHandle(app, orderId).query(stateQuery)).step).toBe('AWAITING_AUTH');
    expect((await readOrder(app, orderId)).status).toBe('PENDING');
    expect((await readReservationOrder(app, orderId))?.status).toBe('HELD');
  };

  const expectCleanLedger = async (sku: SellableSku) =>
    expect((await auditLedgerInvariants(app, { [sku.variantId]: ON_HAND })).violations).toEqual([]);

  it('drops an authorization whose amount is off, and still pays on the real one', async () => {
    const { sku, orderId, sessionId, paymentId } = await placedWithSession();
    const statusOf = vi.spyOn(payment(), 'statusOf');
    const capture = vi.spyOn(payment(), 'capture');
    await queueForgedAuthorization(app, forged(orderId, paymentId, PRICE - 1));

    await relayAuthorization(app, orderId);

    await expectStillWaiting(orderId);
    // Dropped on the amount alone: asking payment would have refused it anyway, header still OPEN.
    expect(statusOf).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    const intentId = await authorizeSession(app, sessionId, orderId);
    await relayAuthorization(app, orderId);
    await untilOrderStatus(app, orderId, 'PAID');
    expect(gateway.captureCalls(intentId)).toBe(1);
    await expectCleanLedger(sku);
  });

  it('commits nothing on an authorization payment does not back yet, then pays on the real one', async () => {
    const { sku, orderId, sessionId, paymentId } = await placedWithSession();
    expect((await readPaymentOrder(app, orderId))?.status).toBe('OPEN');
    const statusOf = vi.spyOn(payment(), 'statusOf');
    const capture = vi.spyOn(payment(), 'capture');
    await queueForgedAuthorization(app, forged(orderId, paymentId));

    await relayAuthorization(app, orderId);

    await eventually(
      () => statusOf.mock.settledResults.filter(({ type }) => type !== 'incomplete').length,
      (settled) => settled >= 1,
    );
    await expectStillWaiting(orderId);
    expect(capture).not.toHaveBeenCalled();
    const intentId = await authorizeSession(app, sessionId, orderId);
    await relayAuthorization(app, orderId);
    await untilOrderStatus(app, orderId, 'PAID');
    expect(gateway.captureCalls(intentId)).toBe(1);
    await expectCleanLedger(sku);
  });

  it('fails the order and voids the payment when its stock was released before the commit', async () => {
    const { sku, orderId, sessionId } = await placedWithSession();
    await inventory().release(orderId);
    const intentId = await authorizeSession(app, sessionId, orderId);

    await relayAuthorization(app, orderId);

    await untilOrderStatus(app, orderId, 'FAILED');
    expect((await readOrder(app, orderId)).finalizeReason).toBe('saga:commit_conflict');
    await eventually(
      () => gateway.wasVoided(intentId),
      (voided) => voided,
    );
    expect(gateway.captureCalls(intentId)).toBe(0);
    expect(await sagaHandle(app, orderId).result()).toBe('COMPENSATED');
    await expectCleanLedger(sku);
  });

  it('fails the order and restocks when the hold is gone by capture time', async () => {
    const { sku, orderId, sessionId } = await placedWithSession();
    const intentId = await authorizeSession(app, sessionId, orderId);
    gateway.failCapture(intentId, 'expired');

    await relayAuthorization(app, orderId);

    await untilOrderStatus(app, orderId, 'FAILED');
    expect(await sagaHandle(app, orderId).result()).toBe('COMPENSATED');
    expect((await reservationsFor(app, orderId)).map(({ status }) => status)).toEqual(['RESTOCKED']);
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: ON_HAND, quantityReserved: 0 });
    expect(gateway.captureCalls(intentId)).toBe(0);
    await expectCleanLedger(sku);
  });

  it('retries a capture that conflicts once and pays', async () => {
    const { sku, orderId, sessionId } = await placedWithSession();
    const capture = vi.spyOn(payment(), 'capture').mockResolvedValueOnce('CONFLICT');
    const intentId = await authorizeSession(app, sessionId, orderId);

    await relayAuthorization(app, orderId);

    await untilOrderStatus(app, orderId, 'PAID');
    expect(capture).toHaveBeenCalledTimes(2);
    expect(gateway.captureCalls(intentId)).toBe(1);
    await expectCleanLedger(sku);
  });

  it('ignores a second authorization that arrives while the first is being captured', async () => {
    const { sku, orderId, sessionId, paymentId } = await placedWithSession();
    const statusOf = vi.spyOn(payment(), 'statusOf');
    const capture = holdCalls(payment(), 'capture');
    const intentId = await authorizeSession(app, sessionId, orderId);
    await relayAuthorization(app, orderId);
    await capture.waitForCalls(1);

    // The same payment again, so only the step guard stands between it and a second verify.
    await queueForgedAuthorization(app, forged(orderId, paymentId));
    await relayAuthorization(app, orderId);
    capture.release();

    await untilOrderStatus(app, orderId, 'PAID');
    expect(statusOf).toHaveBeenCalledOnce();
    expect(gateway.captureCalls(intentId)).toBe(1);
    await expectCleanLedger(sku);
  });
});
