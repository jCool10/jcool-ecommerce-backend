import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Client } from '@temporalio/client';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ORDER_PAYMENT_PARTICIPANT,
  type OrderPaymentParticipantPort,
} from '../../src/modules/order/application/ports/order-payment-participant.port';
import { checkoutWorkflowId } from '../../src/modules/order/infrastructure/temporal/checkout-saga.contract';
import { checkoutSagaRunsOf } from '../../src/modules/order/infrastructure/temporal/temporal-checkout-saga.engine';
import { TEMPORAL_CLIENT } from '../../src/modules/order/infrastructure/temporal/temporal.providers';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/bearer.helper';
import { eventually } from '../setup/eventually';
import {
  failAlways,
  relayAuthorization,
  releaseHung,
  sagaEngine,
  sagaHandle,
} from '../setup/fixtures/checkout-saga.fixture';
import {
  authorizeSession,
  buyerWithCart,
  checkout,
  openSession,
  seedSellableSku,
  untilOrderStatus,
} from '../setup/fixtures/order-flow.fixture';
import {
  closeAppAfterAll,
  createTestAppWithFakeGateway,
  createTestAppWithPool,
  resetSagasAndDatabaseBeforeEach,
} from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { E2E_METRICS_TOKEN, scrapeMetrics, type MetricsScrape } from '../setup/metrics.helper';
import { UNREACHABLE_TEMPORAL_ADDRESS } from '../setup/temporal-server';
import { temporalTaskQueueForCurrentSpec } from '../setup/temporal-task-queue';

const WEBHOOK_SECRET = 'whsec_e2e_checkout_saga_metrics_00001';
const PRICE = 80_000;
const CURRENCY = 'VND';
const OPEN_STEPS = ['RESERVING', 'AWAITING_AUTH', 'COMMITTING_STOCK', 'CAPTURING', 'COMPENSATING'];
// A queue of its own per run, so nothing an earlier run closed on it within the hour shows up here.
const METRICS_ENV = {
  METRICS_TOKEN: E2E_METRICS_TOKEN,
  TEMPORAL_TASK_QUEUE: temporalTaskQueueForCurrentSpec(randomUUID().slice(0, 8)),
  SAGA_RETRY_BASE_MS: '100',
  SAGA_RETRY_CAP_MS: '500',
};

/** Visibility lags, so a gauge read from it is polled until it shows what the test did. */
function untilMetrics(app: INestApplication, done: (metrics: MetricsScrape) => boolean): Promise<MetricsScrape> {
  return eventually(() => scrapeMetrics(app), done, 10_000);
}

describe('Checkout saga metrics (integration, real Temporal, fake Stripe)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithFakeGateway(WEBHOOK_SECRET, METRICS_ENV));
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app],
    () => pool,
  );
  afterEach(() => {
    releaseHung();
  });

  const counter = (metrics: MetricsScrape, name: string, labels: Record<string, string>) =>
    metrics.value(name, labels) ?? 0;

  async function placed() {
    const sku = await seedSellableSku(app, { onHand: 3, priceMinor: PRICE });
    const token = await buyerWithCart(app, sku.variantId);
    const orderId = (await checkout(app, token).expect(201)).body.id as string;
    return { token, orderId };
  }

  async function seedOrder(status: (typeof schema.orderStatus.enumValues)[number], deadlineAt: Date) {
    const orderId = testId();
    await db.insert(schema.orders).values({
      id: orderId,
      userId: testId(),
      status,
      currency: CURRENCY,
      totalAmount: PRICE,
      placedAt: new Date(deadlineAt.getTime() - 3_600_000),
      finalizedAt: new Date(),
      paymentDeadlineAt: deadlineAt,
    });
    return orderId;
  }

  it('reports a checkout waiting for payment, the workers polling it, and its Try', async () => {
    const before = await scrapeMetrics(app);

    await placed();

    const metrics = await untilMetrics(app, (m) => m.value('checkout_sagas_open', { step: 'AWAITING_AUTH' }) === 1);
    for (const step of OPEN_STEPS.filter((open) => open !== 'AWAITING_AUTH')) {
      expect(metrics.value('checkout_sagas_open', { step }), step).toBe(0);
    }
    expect(metrics.value('checkout_saga_task_queue_pollers', { task_type: 'workflow' })).toBeGreaterThanOrEqual(1);
    expect(metrics.value('checkout_saga_task_queue_pollers', { task_type: 'activity' })).toBeGreaterThanOrEqual(1);
    expect(metrics.value('checkout_saga_engine_up')).toBe(1);
    const reserved = { step: 'try_reserve', outcome: 'reserved' };
    expect(counter(metrics, 'saga_step_total', reserved)).toBe(counter(before, 'saga_step_total', reserved) + 1);
  });

  it('counts the commit and the capture of a paid checkout', async () => {
    const { token, orderId } = await placed();
    const before = await scrapeMetrics(app);
    const pay = await openSession(app, token, orderId).expect(201);
    await authorizeSession(app, pay.body.providerSessionId as string, orderId);

    await relayAuthorization(app, orderId);
    await untilOrderStatus(app, orderId, 'PAID');

    const after = await scrapeMetrics(app);
    for (const labels of [
      { step: 'commit_stock', outcome: 'applied' },
      { step: 'capture_payment', outcome: 'captured' },
    ]) {
      expect(counter(after, 'saga_step_total', labels), labels.step).toBe(
        counter(before, 'saga_step_total', labels) + 1,
      );
    }
  });

  it('counts the stock released by a cancel', async () => {
    const { token, orderId } = await placed();
    const released = { kind: 'release_stock', reason: 'cancelled' };
    const before = counter(await scrapeMetrics(app), 'saga_compensation_total', released);

    await request(app.getHttpServer()).post(`/orders/${orderId}/cancel`).set(authHeader(token)).expect(200);
    await sagaHandle(app, orderId).result();

    expect(counter(await scrapeMetrics(app), 'saga_compensation_total', released)).toBe(before + 1);
  });

  it('reports a saga still running past its deadline plus grace as overdue', async () => {
    const deadlineAt = new Date(Date.now() - 400_000);
    // Written first, so the reset can find the run and end it.
    const orderId = await seedOrder('CANCELLED', deadlineAt);
    failAlways(app.get<OrderPaymentParticipantPort>(ORDER_PAYMENT_PARTICIPANT), 'cancel', { orderId });

    await sagaEngine(app).notifyAuthorized(
      {
        mode: 'lateAuthorization',
        orderId,
        userId: testId(),
        lines: [{ skuId: testId(), quantity: 1 }],
        totalMinor: PRICE,
        currency: CURRENCY,
        placedAt: new Date(deadlineAt.getTime() - 3_600_000),
        deadlineAt,
      },
      { paymentId: testId(), amountMinor: PRICE, currency: CURRENCY, authorizedAt: new Date().toISOString() },
    );

    const metrics = await untilMetrics(app, (m) => m.value('checkout_saga_overdue') === 1);
    expect(metrics.value('checkout_sagas_open', { step: 'COMPENSATING' })).toBe(1);
  });

  it('counts a terminated saga among the abnormal closes', async () => {
    const { orderId } = await placed();
    const terminated = { status: 'Terminated' };
    // The reset terminated the last test's runs; until visibility shows them closed they would land
    // in the count after the baseline.
    const others = `${checkoutSagaRunsOf(METRICS_ENV.TEMPORAL_TASK_QUEUE)} AND ExecutionStatus = 'Running' AND WorkflowId != '${checkoutWorkflowId(orderId)}'`;
    const client = app.get<Client>(TEMPORAL_CLIENT);
    await eventually(
      async () => (await client.workflow.count(others)).count,
      (running) => running === 0,
    );
    const before = counter(await scrapeMetrics(app), 'checkout_saga_closed_abnormally', terminated);

    await sagaHandle(app, orderId).terminate('metrics test');

    const metrics = await untilMetrics(
      app,
      (m) => counter(m, 'checkout_saga_closed_abnormally', terminated) === before + 1,
    );
    expect(metrics.value('checkout_saga_closed_abnormally', { status: 'Failed' })).toBe(0);
  });

  it('reports how long the oldest authorization has waited for its capture', async () => {
    const orderId = await seedOrder('PENDING', new Date(Date.now() + 600_000));
    await db.insert(schema.paymentOrders).values({
      orderId,
      status: 'AUTHORIZED',
      amountMinor: PRICE,
      currency: CURRENCY,
      authorizedAt: new Date(Date.now() - 1_200_000),
    });

    const metrics = await scrapeMetrics(app);

    // The gauge reads the database clock, which can sit a few milliseconds off this process's.
    expect(metrics.value('payment_authorized_uncaptured_oldest_seconds')).toBeCloseTo(1_200, -1);
  });

  it('reports the depth of the queue that carries authorizations to the saga', async () => {
    const metrics = await scrapeMetrics(app);

    for (const state of ['wait', 'prioritized', 'active', 'delayed']) {
      expect(metrics.value('messaging_queue_jobs', { queue: 'domain-events', state }), state).toBeDefined();
    }
    expect(metrics.value('messaging_queue_oldest_waiting_seconds', { queue: 'domain-events' })).toBeDefined();
    expect(metrics.value('messaging_queue_jobs', { queue: 'domain-events-dlq' })).toBeUndefined();
  });
});

describe('Checkout saga metrics with Temporal unreachable (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestAppWithPool({
      ...METRICS_ENV,
      TEMPORAL_ADDRESS: UNREACHABLE_TEMPORAL_ADDRESS,
      TEMPORAL_TASK_QUEUE: temporalTaskQueueForCurrentSpec('unreachable'),
      TEMPORAL_WORKER_SHUTDOWN_GRACE_MS: '500',
      TEMPORAL_WORKER_SHUTDOWN_FORCE_MS: '500',
    }));
  });
  closeAppAfterAll(() => app);

  // The api's readiness leaves Temporal out, so this gauge is the only thing that says it is gone.
  it('still answers /metrics, with the engine down and no saga gauge, while the api stays ready', async () => {
    const startedAt = Date.now();
    const metrics = await scrapeMetrics(app);

    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(metrics.value('checkout_saga_engine_up')).toBe(0);
    expect(metrics.has('checkout_sagas_open')).toBe(false);
    expect(metrics.has('checkout_saga_overdue')).toBe(false);
    await request(app.getHttpServer()).get('/health/ready').expect(200);
  });
});

describe('Checkout saga metrics with no worker on the task queue (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestAppWithPool({
      ...METRICS_ENV,
      TEMPORAL_WORKER_ENABLED: 'false',
      TEMPORAL_TASK_QUEUE: temporalTaskQueueForCurrentSpec(`noworker-${randomUUID().slice(0, 8)}`),
    }));
  });
  closeAppAfterAll(() => app);

  it('reports no poller on either task type', async () => {
    const metrics = await scrapeMetrics(app);

    expect(metrics.value('checkout_saga_engine_up')).toBe(1);
    expect(metrics.value('checkout_saga_task_queue_pollers', { task_type: 'workflow' })).toBe(0);
    expect(metrics.value('checkout_saga_task_queue_pollers', { task_type: 'activity' })).toBe(0);
  });
});
