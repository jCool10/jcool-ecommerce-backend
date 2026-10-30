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
import { PAYMENT_SERVICE_BREAKER } from '../../src/modules/order/infrastructure/order-payment-participant.http-adapter';
import { stateQuery } from '../../src/modules/order/infrastructure/temporal/checkout-saga.contract';
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
  authorizePayment,
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
import { closeAppAfterAll, createTestAppWithPool, resetSagasAndDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { type InventoryServiceStub, inventoryServiceStub } from '../setup/inventory-service-stub';
import { E2E_METRICS_TOKEN, scrapeMetrics } from '../setup/metrics.helper';
import { type PaymentServiceStub, paymentServiceStub } from '../setup/payment-service-stub';

const PRICE = 70_000;
const ON_HAND = 5;
const SAGA_ENV = { SAGA_RETRY_BASE_MS: '100', SAGA_RETRY_CAP_MS: '500' };
const BREAKER_OPEN = 2;

let payment: PaymentServiceStub;
let inventoryService: InventoryServiceStub;

beforeAll(async () => {
  payment = await paymentServiceStub();
  inventoryService = await inventoryServiceStub();
});

async function placedWithSession(app: INestApplication): Promise<{
  sku: SellableSku;
  orderId: string;
  paymentId: string;
}> {
  const sku = await seedSellableSku(app, { onHand: ON_HAND, priceMinor: PRICE });
  const token = await buyerWithCart(app, sku.variantId);
  const orderId = (await checkout(app, token).expect(201)).body.id as string;
  const pay = await openSession(app, token, orderId).expect(201);
  return { sku, orderId, paymentId: pay.body.paymentId as string };
}

describe('Checkout saga capture failures (integration, real Temporal, fake Stripe)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool(SAGA_ENV));
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
  const participant = () => app.get<OrderPaymentParticipantPort>(ORDER_PAYMENT_PARTICIPANT);

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
    const { sku, orderId, paymentId } = await placedWithSession(app);
    const statusOf = vi.spyOn(participant(), 'statusOf');
    const capture = vi.spyOn(participant(), 'capture');
    await queueForgedAuthorization(app, forged(orderId, paymentId, PRICE - 1));

    await relayAuthorization(app, orderId);

    await expectStillWaiting(orderId);
    // Dropped on the amount alone: asking payment would have refused it anyway, header still OPEN.
    expect(statusOf).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    await authorizePayment(orderId);
    await relayAuthorization(app, orderId);
    await untilOrderStatus(app, orderId, 'PAID');
    expect(payment.providerCaptures(orderId)).toBe(1);
    await expectCleanLedger(sku);
  });

  it('commits nothing on an authorization payment does not back yet, then pays on the real one', async () => {
    const { sku, orderId, paymentId } = await placedWithSession(app);
    expect((await readPaymentOrder(app, orderId))?.status).toBe('OPEN');
    const statusOf = vi.spyOn(participant(), 'statusOf');
    const capture = vi.spyOn(participant(), 'capture');
    await queueForgedAuthorization(app, forged(orderId, paymentId));

    await relayAuthorization(app, orderId);

    await eventually(
      () => statusOf.mock.settledResults.filter(({ type }) => type !== 'incomplete').length,
      (settled) => settled >= 1,
    );
    await expectStillWaiting(orderId);
    expect(capture).not.toHaveBeenCalled();
    await authorizePayment(orderId);
    await relayAuthorization(app, orderId);
    await untilOrderStatus(app, orderId, 'PAID');
    expect(payment.providerCaptures(orderId)).toBe(1);
    await expectCleanLedger(sku);
  });

  it('drops a forged authorization over the status API until payment really holds the money', async () => {
    const { sku, orderId, paymentId } = await placedWithSession(app);
    const verifies = (count: number) =>
      eventually(
        () => payment.calls('status'),
        (calls) => calls >= count,
      );
    // Payment holds money for another attempt than the one the signal names.
    payment.setStatus(orderId, {
      header: 'AUTHORIZED',
      authorizedPaymentId: testId(),
      hasAuthorizedAttempt: true,
      hasSucceededAttempt: false,
    });
    await queueForgedAuthorization(app, forged(orderId, paymentId));
    await relayAuthorization(app, orderId);
    await verifies(1);
    await expectStillWaiting(orderId);

    payment.clearStatus(orderId);
    await queueForgedAuthorization(app, forged(orderId, paymentId));
    await relayAuthorization(app, orderId);
    await verifies(2);
    await expectStillWaiting(orderId);
    expect(inventoryService.calls('commit')).toBe(0);
    expect(payment.calls('capture')).toBe(0);

    await authorizePayment(orderId);
    await relayAuthorization(app, orderId);
    await untilOrderStatus(app, orderId, 'PAID');
    expect(payment.providerCaptures(orderId)).toBe(1);
    await expectCleanLedger(sku);
  });

  it('retries the verify while payment cannot answer for a moment, and keeps the real authorization', async () => {
    const { sku, orderId } = await placedWithSession(app);
    await authorizePayment(orderId);
    payment.fail('status', 503, { times: 2 });

    await relayAuthorization(app, orderId);

    await untilOrderStatus(app, orderId, 'PAID');
    expect(payment.calls('status')).toBe(3);
    expect(payment.providerCaptures(orderId)).toBe(1);
    await expectCleanLedger(sku);
  });

  it('fails the order and voids the payment when its stock was released before the commit', async () => {
    const { sku, orderId } = await placedWithSession(app);
    await inventory().release(orderId);
    await authorizePayment(orderId);

    await relayAuthorization(app, orderId);

    await untilOrderStatus(app, orderId, 'FAILED');
    expect((await readOrder(app, orderId)).finalizeReason).toBe('saga:commit_conflict');
    await eventually(
      () => payment.sessionFor(orderId)?.status,
      (attempt) => attempt === 'VOIDED',
    );
    expect(payment.providerCaptures(orderId)).toBe(0);
    expect(await sagaHandle(app, orderId).result()).toBe('COMPENSATED');
    await expectCleanLedger(sku);
  });

  it('fails the order and restocks when the hold is gone by capture time', async () => {
    const { sku, orderId } = await placedWithSession(app);
    await authorizePayment(orderId);
    payment.dropHold(orderId);

    await relayAuthorization(app, orderId);

    await untilOrderStatus(app, orderId, 'FAILED');
    expect(await sagaHandle(app, orderId).result()).toBe('COMPENSATED');
    expect((await reservationsFor(app, orderId)).map(({ status }) => status)).toEqual(['RESTOCKED']);
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: ON_HAND, quantityReserved: 0 });
    expect(payment.providerCaptures(orderId)).toBe(0);
    await expectCleanLedger(sku);
  });

  it('retries a capture that conflicts once and pays', async () => {
    const { sku, orderId } = await placedWithSession(app);
    const capture = vi.spyOn(participant(), 'capture').mockResolvedValueOnce('CONFLICT');
    await authorizePayment(orderId);

    await relayAuthorization(app, orderId);

    await untilOrderStatus(app, orderId, 'PAID');
    expect(capture).toHaveBeenCalledTimes(2);
    expect(payment.providerCaptures(orderId)).toBe(1);
    await expectCleanLedger(sku);
  });

  it('retries a capture the payment-service fails twice, and captures once without compensating', async () => {
    const { sku, orderId } = await placedWithSession(app);
    await authorizePayment(orderId);
    payment.fail('capture', 500, { times: 2 });

    await relayAuthorization(app, orderId);

    await untilOrderStatus(app, orderId, 'PAID');
    expect(await sagaHandle(app, orderId).result()).toBe('COMPLETED');
    expect(payment.calls('capture')).toBe(3);
    expect(payment.providerCaptures(orderId)).toBe(1);
    await expectCleanLedger(sku);
  });

  it('ignores a second authorization that arrives while the first is being captured', async () => {
    const { sku, orderId, paymentId } = await placedWithSession(app);
    const statusOf = vi.spyOn(participant(), 'statusOf');
    const capture = holdCalls(participant(), 'capture');
    await authorizePayment(orderId);
    await relayAuthorization(app, orderId);
    await capture.waitForCalls(1);

    // The same payment again, so only the step guard stands between it and a second verify.
    await queueForgedAuthorization(app, forged(orderId, paymentId));
    await relayAuthorization(app, orderId);
    capture.release();

    await untilOrderStatus(app, orderId, 'PAID');
    expect(statusOf).toHaveBeenCalledOnce();
    expect(payment.providerCaptures(orderId)).toBe(1);
    await expectCleanLedger(sku);
  });
});

// An app of its own: successes other cases left in the breaker's window would hide a miscounted burst.
describe('Checkout saga while Stripe is away (integration, real Temporal, stub)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool({ ...SAGA_ENV, METRICS_TOKEN: E2E_METRICS_TOKEN }));
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app],
    () => pool,
  );

  // The state alone cannot say "throughout": a circuit that opened and half-opened back is closed again by the end.
  const timesOpened = async () =>
    (await scrapeMetrics(app)).value('circuit_breaker_transitions_total', {
      breaker: PAYMENT_SERVICE_BREAKER,
      to: 'open',
    }) ?? 0;

  it('answers /pay 502 while Stripe is away, then opens the session, with the breaker closed throughout', async () => {
    const sku = await seedSellableSku(app, { onHand: ON_HAND, priceMinor: PRICE });
    const token = await buyerWithCart(app, sku.variantId);
    const orderId = (await checkout(app, token).expect(201)).body.id as string;
    // Past the breaker's volume threshold, like the capture case below.
    payment.providerDown('session', { times: 6 });

    for (let i = 0; i < 6; i++) await openSession(app, token, orderId).expect(502);
    await openSession(app, token, orderId).expect(201);

    expect(payment.calls('session')).toBe(7);
    expect(await timesOpened()).toBe(0);
  });

  it('retries a capture through a Stripe outage until one lands, with the breaker closed throughout', async () => {
    const { sku, orderId } = await placedWithSession(app);
    await authorizePayment(orderId);
    // More than the breaker's volume threshold, so counting the coded 503 as a fault would open it.
    payment.providerDown('capture', { times: 6 });

    await relayAuthorization(app, orderId);

    await untilOrderStatus(app, orderId, 'PAID');
    expect(payment.calls('capture')).toBe(7);
    expect(payment.providerCaptures(orderId)).toBe(1);
    expect(await timesOpened()).toBe(0);
    expect((await auditLedgerInvariants(app, { [sku.variantId]: ON_HAND })).violations).toEqual([]);
  });
});

describe('Checkout saga capture behind an open payment-service breaker (integration, real Temporal, stub)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    // Long enough that the circuit cannot half-open while the case runs.
    ({ app, pool } = await createTestAppWithPool({
      ...SAGA_ENV,
      METRICS_TOKEN: E2E_METRICS_TOKEN,
      BREAKER_RESET_TIMEOUT_MS: '60000',
    }));
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app],
    () => pool,
  );

  const breakerState = async () =>
    (await scrapeMetrics(app)).value('circuit_breaker_state', { breaker: PAYMENT_SERVICE_BREAKER });

  it('keeps retrying the capture while the circuit is open, and compensates nothing', async () => {
    const { orderId } = await placedWithSession(app);
    await authorizePayment(orderId);
    payment.fail('capture', 503, { times: Infinity });

    await relayAuthorization(app, orderId);

    await expect.poll(breakerState, { timeout: 10_000 }).toBe(BREAKER_OPEN);
    const capturesSoFar = payment.calls('capture');
    // A few more retry rounds, every one refused by the open circuit.
    await eventually(
      async () => (await sagaHandle(app, orderId).describe()).raw.pendingActivities?.[0]?.attempt ?? 0,
      (attempt) => attempt >= capturesSoFar + 3,
    );
    expect((await sagaHandle(app, orderId).query(stateQuery)).step).toBe('CAPTURING');
    expect((await readOrder(app, orderId)).status).toBe('CONFIRMING');
    expect((await readReservationOrder(app, orderId))?.status).toBe('COMMITTED');
    expect((await readPaymentOrder(app, orderId))?.status).toBe('AUTHORIZED');
    // The open circuit answers the retries itself.
    expect(payment.calls('capture')).toBe(capturesSoFar);
    expect(payment.calls('cancel')).toBe(0);
  });
});
