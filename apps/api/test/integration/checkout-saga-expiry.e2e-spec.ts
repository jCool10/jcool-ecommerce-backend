import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { drainDomainEvents } from '../setup/domain-events';
import { eventually } from '../setup/eventually';
import { SHORT_DEADLINE_CHECKOUT_ENV, relayAuthorization, sagaHandle } from '../setup/fixtures/checkout-saga.fixture';
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
  seedSellableSku,
  untilOrderStatus,
} from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetSagasAndDatabaseBeforeEach } from '../setup/harness';
import { sleep } from '../setup/sleep';

const WEBHOOK_SECRET = 'whsec_e2e_checkout_saga_expiry_0001';
const GRACE_MS = Number(SHORT_DEADLINE_CHECKOUT_ENV.SAGA_AUTH_GRACE_SEC) * 1000;
// How long past deadline + grace the expiry may take to land; a bound, not a sleep.
const SETTLE_MS = 5000;

describe('Checkout saga expiry (integration, real Temporal, short payment window)', () => {
  let app: INestApplication;
  let pool: Pool;
  let gateway: FakeSignerGatewayAdapter;

  beforeAll(async () => {
    ({ app, pool, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, SHORT_DEADLINE_CHECKOUT_ENV));
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app],
    () => pool,
  );

  async function placedWithSession() {
    const sku = await seedSellableSku(app, { onHand: 4 });
    const token = await buyerWithCart(app, sku.variantId);
    const orderId = (await checkout(app, token).expect(201)).body.id as string;
    const pay = await openSession(app, token, orderId).expect(201);
    const deadlineMs = ((await readOrder(app, orderId)).paymentDeadlineAt as Date).getTime();
    return { sku, orderId, sessionId: pay.body.providerSessionId as string, deadlineMs };
  }

  it('expires an order nobody pays for, gives the stock back and closes the session', async () => {
    const { sku, orderId, sessionId, deadlineMs } = await placedWithSession();

    await untilOrderStatus(app, orderId, 'EXPIRED', deadlineMs + GRACE_MS + SETTLE_MS - Date.now());

    expect((await readOrder(app, orderId)).finalizeReason).toBe('saga:expired');
    expect(await sagaHandle(app, orderId).result()).toBe('COMPENSATED');
    expect((await readStock(app, sku.variantId))?.quantityReserved).toBe(0);
    expect((await readReservationOrder(app, orderId))?.status).toBe('RELEASED');
    expect((await readPaymentOrder(app, orderId))?.status).toBe('CANCELLED');
    expect(gateway.wasExpired(sessionId)).toBe(true);
    expect((await auditLedgerInvariants(app, { [sku.variantId]: 4 })).violations).toEqual([]);
  });

  it('pays an authorization that lands after the deadline but inside the grace window', async () => {
    const { sku, orderId, sessionId, deadlineMs } = await placedWithSession();
    await sleep(deadlineMs - Date.now() + GRACE_MS / 3);

    const intentId = await authorizeSession(app, sessionId, orderId);
    await relayAuthorization(app, orderId);

    await untilOrderStatus(app, orderId, 'PAID');
    expect(gateway.captureCalls(intentId)).toBe(1);
    expect(gateway.wasVoided(intentId)).toBe(false);
    expect((await auditLedgerInvariants(app, { [sku.variantId]: 4 })).violations).toEqual([]);
  });

  it('voids an authorization that lands after the grace window and keeps the order expired', async () => {
    const { sku, orderId, sessionId, deadlineMs } = await placedWithSession();
    await untilOrderStatus(app, orderId, 'EXPIRED', deadlineMs + GRACE_MS + SETTLE_MS - Date.now());

    const intentId = await authorizeSession(app, sessionId, orderId);
    await drainDomainEvents(app);

    await eventually(
      () => gateway.wasVoided(intentId),
      (voided) => voided,
    );
    expect(gateway.captureCalls(intentId)).toBe(0);
    expect((await readOrder(app, orderId)).status).toBe('EXPIRED');
    expect((await auditLedgerInvariants(app, { [sku.variantId]: 4 })).violations).toEqual([]);
  });
});
