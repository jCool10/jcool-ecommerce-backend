import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { INVENTORY_SERVICE_BREAKER } from '../../src/modules/order/infrastructure/order-inventory-participant.http-adapter';
import { sagaHandle } from '../setup/fixtures/checkout-saga.fixture';
import {
  auditLedgerInvariants,
  buyerWithCart,
  checkout,
  driveToPaid,
  seedSellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetSagasAndDatabaseBeforeEach } from '../setup/harness';
import {
  type InventoryServiceStub,
  type InventoryStubRoute,
  inventoryServiceStub,
} from '../setup/inventory-service-stub';
import { E2E_METRICS_TOKEN, scrapeMetrics } from '../setup/metrics.helper';

const WEBHOOK_SECRET = 'whsec_e2e_checkout_saga_inventory_faults_01';
const ON_HAND = 5;
// The production default; nothing here may wait it out.
const TRY_TIMEOUT_MS = 3000;
const SAGA_ENV = { SAGA_RETRY_BASE_MS: '100', SAGA_RETRY_CAP_MS: '500', METRICS_TOKEN: E2E_METRICS_TOKEN };
const BREAKER_CLOSED = 0;
const BREAKER_OPEN = 2;
const ROUTES: InventoryStubRoute[] = ['try', 'commit', 'release', 'restock', 'status'];

const breakerState = async (app: INestApplication) =>
  (await scrapeMetrics(app)).value('circuit_breaker_state', { breaker: INVENTORY_SERVICE_BREAKER });
// The state alone cannot say "throughout": a circuit that opened and half-opened back is closed again by the end.
const timesOpened = async (app: INestApplication) =>
  (await scrapeMetrics(app)).value('circuit_breaker_transitions_total', {
    breaker: INVENTORY_SERVICE_BREAKER,
    to: 'open',
  }) ?? 0;

describe('Checkout saga over a faulty inventory-service (integration, real Temporal, stub)', () => {
  let inventoryService: InventoryServiceStub;

  beforeAll(async () => {
    inventoryService = await inventoryServiceStub();
  });

  describe('when commits fail for a while', () => {
    let app: INestApplication;
    let pool: Pool;

    beforeAll(async () => {
      ({ app, pool } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, SAGA_ENV));
    });
    closeAppAfterAll(() => app);
    resetSagasAndDatabaseBeforeEach(
      () => [app],
      () => pool,
    );

    async function placed() {
      const sku = await seedSellableSku(app, { onHand: ON_HAND });
      const token = await buyerWithCart(app, sku.variantId);
      const orderId = (await checkout(app, token).expect(201)).body.id as string;
      return { sku, token, orderId };
    }

    it('retries a commit answered 500 twice and settles PAID without compensating', async () => {
      const { sku, token, orderId } = await placed();
      inventoryService.fail('commit', 500, { times: 2 });

      await driveToPaid(app, token, orderId);

      expect(await sagaHandle(app, orderId).result()).toBe('COMPLETED');
      expect(inventoryService.calls('commit')).toBe(3);
      expect(inventoryService.calls('release') + inventoryService.calls('restock')).toBe(0);
      expect(inventoryService.headerOf(orderId)?.status).toBe('COMMITTED');
      expect((await auditLedgerInvariants(app, { [sku.variantId]: ON_HAND })).violations).toEqual([]);
    });

    it('retries throttled commits until one lands, with the breaker closed throughout', async () => {
      const { token, orderId } = await placed();
      const opened = await timesOpened(app);
      // More than the breaker's volume threshold, so counting a 429 as a fault would open it.
      inventoryService.fail('commit', 429, { times: 6 });

      await driveToPaid(app, token, orderId);

      expect(inventoryService.calls('commit')).toBe(7);
      expect(await timesOpened(app)).toBe(opened);
      expect(await breakerState(app)).toBe(BREAKER_CLOSED);
    });
  });

  // An app of its own: successes other cases left in the breaker's window would hide a miscounted burst.
  describe('when a hot SKU keeps its stock rows busy', () => {
    let app: INestApplication;
    let pool: Pool;

    beforeAll(async () => {
      ({ app, pool } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, SAGA_ENV));
    });
    closeAppAfterAll(() => app);
    resetSagasAndDatabaseBeforeEach(
      () => [app],
      () => pool,
    );

    it('retries commits held up by busy stock rows until one lands, with the breaker closed throughout', async () => {
      const sku = await seedSellableSku(app, { onHand: ON_HAND });
      const token = await buyerWithCart(app, sku.variantId);
      const orderId = (await checkout(app, token).expect(201)).body.id as string;
      inventoryService.busy('commit', { times: 6 });

      await driveToPaid(app, token, orderId);

      expect(inventoryService.calls('commit')).toBe(7);
      expect(inventoryService.headerOf(orderId)?.status).toBe('COMMITTED');
      expect(await timesOpened(app)).toBe(0);
      expect(await breakerState(app)).toBe(BREAKER_CLOSED);
    });
  });

  describe('when the service keeps answering 503', () => {
    let app: INestApplication;
    let pool: Pool;

    beforeAll(async () => {
      // Long enough that the circuit cannot half-open while the case runs.
      ({ app, pool } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, {
        ...SAGA_ENV,
        BREAKER_RESET_TIMEOUT_MS: '60000',
      }));
    });
    closeAppAfterAll(() => app);
    resetSagasAndDatabaseBeforeEach(
      () => [app],
      () => pool,
    );

    it('opens the breaker, then refuses the next checkout fast without calling the service', async () => {
      for (const route of ROUTES) inventoryService.fail(route, 503, { times: Infinity });
      const sku = await seedSellableSku(app, { onHand: ON_HAND });

      await checkout(app, await buyerWithCart(app, sku.variantId)).expect(503);
      // The rejected order's release retries into the 503s until the circuit opens on them.
      await expect.poll(() => breakerState(app), { timeout: 10_000 }).toBe(BREAKER_OPEN);
      const triesSoFar = inventoryService.calls('try');

      const startedAt = Date.now();
      const refused = await checkout(app, await buyerWithCart(app, sku.variantId)).expect(503);

      expect(refused.headers['retry-after']).toBeDefined();
      expect(Date.now() - startedAt).toBeLessThan(TRY_TIMEOUT_MS);
      expect(inventoryService.calls('try')).toBe(triesSoFar);
    });
  });
});
