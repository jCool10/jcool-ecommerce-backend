import type { INestApplication } from '@nestjs/common';
import type { Client } from '@temporalio/client';
import { PinoLogger } from 'nestjs-pino';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CheckoutEngineUnavailableError,
  type CheckoutSagaStart,
} from '../../src/modules/order/application/ports/checkout-saga-engine.port';
import {
  ORDER_INVENTORY_PARTICIPANT,
  type OrderInventoryParticipantPort,
} from '../../src/modules/order/application/ports/order-inventory-participant.port';
import {
  ORDER_REPOSITORY,
  type OrderRepositoryPort,
} from '../../src/modules/order/application/ports/order-repository.port';
import { OrderItem } from '../../src/modules/order/domain/order-item.entity';
import { Order } from '../../src/modules/order/domain/order.entity';
import { checkoutWorkflowId } from '../../src/modules/order/infrastructure/temporal/checkout-saga.contract';
import { TEMPORAL_CLIENT } from '../../src/modules/order/infrastructure/temporal/temporal.providers';
import { PG_POOL } from '../../src/shared/infrastructure/database/drizzle.tokens';
import {
  checkoutSagaStartOf,
  holdCalls,
  releaseHung,
  resetCheckoutSagas,
  sagaEngine,
  sagaWorker,
} from '../setup/fixtures/checkout-saga.fixture';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { readOrder } from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetSagasAndDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { sleep } from '../setup/sleep';
import { UNREACHABLE_TEMPORAL_ADDRESS, TEMPORAL_TEST_NAMESPACE } from '../setup/temporal-server';
import { temporalTaskQueueForCurrentSpec } from '../setup/temporal-task-queue';

const RESERVE_WAIT_MS = 6000;
const WORKER_ON = { TEMPORAL_WORKER_ENABLED: 'true' };
// Values of temporal.api.enums.v1.TaskQueueType.
const TASK_QUEUE_TYPE = { WORKFLOW: 1, ACTIVITY: 2 } as const;

async function eventually<T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`condition not met in ${timeoutMs}ms; last value ${JSON.stringify(value)}`);
    await sleep(50);
  }
}

function shutdownLabel([fields, message]: unknown[]): string | null {
  if (message === 'shutdown signal received; /health/ready now returns 503') return 'readiness down';
  if (message === 'shutdown grace elapsed; running shutdown steps') return 'grace elapsed';
  if (message === 'shutdown step done' || message === 'shutdown step failed') {
    return `step ${(fields as { step: string }).step}`;
  }
  return null;
}

const anyStart = (): CheckoutSagaStart => ({
  mode: 'checkout',
  orderId: testId(),
  userId: testId(),
  lines: [{ skuId: testId(), quantity: 1 }],
  totalMinor: 10_000,
  currency: 'VND',
  placedAt: new Date(),
  deadlineAt: new Date(Date.now() + 60 * 60_000),
});

describe('Temporal platform wiring (integration, real Temporal dev server)', () => {
  let app: INestApplication;
  let pool: Pool;
  const extraApps: INestApplication[] = [];

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool(WORKER_ON));
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app, ...extraApps],
    () => pool,
  );

  async function placeReserving(onApp: INestApplication, onHand = 5) {
    const variantId = testId();
    await seedStock(onApp, variantId, onHand);
    const placedAt = new Date();
    const order = Order.create(testId(), 'VND', [OrderItem.of(variantId, 'Widget', 10_000, 1)]).reserve(
      placedAt,
      new Date(placedAt.getTime() + 60 * 60_000),
    );
    const { order: saved } = await onApp
      .get<OrderRepositoryPort>(ORDER_REPOSITORY)
      .createReserving({ order, idempotencyKey: null });
    return checkoutSagaStartOf(saved);
  }

  it('runs the worker against a live server, with readiness blind to Temporal', async () => {
    await eventually(
      () => sagaWorker(app).status().state,
      (state) => state === 'RUNNING',
    );
    const client = app.get<Client>(TEMPORAL_CLIENT);
    const pollers = (taskQueueType: number) =>
      client.workflowService
        .describeTaskQueue({
          namespace: TEMPORAL_TEST_NAMESPACE,
          taskQueue: { name: temporalTaskQueueForCurrentSpec() },
          taskQueueType,
        })
        .then(({ pollers: found }) => found?.length ?? 0);

    await eventually(
      () => pollers(TASK_QUEUE_TYPE.WORKFLOW),
      (count) => count > 0,
    );
    await eventually(
      () => pollers(TASK_QUEUE_TYPE.ACTIVITY),
      (count) => count > 0,
    );
    const ready = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(ready.body.details).not.toHaveProperty('temporal');
  });

  describe('Temporal unreachable', () => {
    let deadApp: INestApplication;
    let closed = false;
    const graceMs = 500;
    const forceMs = 500;

    beforeAll(async () => {
      ({ app: deadApp } = await createTestAppWithPool({
        ...WORKER_ON,
        TEMPORAL_ADDRESS: UNREACHABLE_TEMPORAL_ADDRESS,
        TEMPORAL_TASK_QUEUE: temporalTaskQueueForCurrentSpec('unreachable'),
        TEMPORAL_WORKER_SHUTDOWN_GRACE_MS: String(graceMs),
        TEMPORAL_WORKER_SHUTDOWN_FORCE_MS: String(forceMs),
      }));
    });
    afterAll(async () => {
      if (!closed) await deadApp?.close();
    });

    it('boots and serves, with the worker retrying in the background', async () => {
      await request(deadApp.getHttpServer()).get('/health/live').expect(200);
      await request(deadApp.getHttpServer()).get('/health/ready').expect(200);
      expect(['CONNECTING', 'BACKOFF']).toContain(sagaWorker(deadApp).status().state);
      await request(deadApp.getHttpServer()).get('/products').expect(200);
    });

    it('fails a reserve as unavailable within the reserve wait', async () => {
      const startedAt = Date.now();

      await expect(sagaEngine(deadApp).reserve(anyStart())).rejects.toBeInstanceOf(CheckoutEngineUnavailableError);
      expect(Date.now() - startedAt).toBeLessThan(RESERVE_WAIT_MS + 1000);
    });

    it('closes within the worker shutdown budget', async () => {
      const startedAt = Date.now();

      await deadApp.close();
      closed = true;

      expect(Date.now() - startedAt).toBeLessThan(graceMs + forceMs + 2000);
      expect(sagaWorker(deadApp).status().state).toBe('STOPPED');
    });
  });

  describe('no worker on the task queue', () => {
    let idleApp: INestApplication;

    beforeAll(async () => {
      ({ app: idleApp } = await createTestAppWithPool({
        TEMPORAL_WORKER_ENABLED: 'false',
        TEMPORAL_TASK_QUEUE: temporalTaskQueueForCurrentSpec('noworker'),
      }));
      extraApps.push(idleApp);
    });
    afterAll(async () => {
      extraApps.splice(extraApps.indexOf(idleApp), 1);
      await idleApp?.close();
    });

    it('answers unavailable within the reserve wait and leaves the order RESERVING for the reset to end', async () => {
      const start = await placeReserving(idleApp);
      const startedAt = Date.now();

      await expect(sagaEngine(idleApp).reserve(start)).rejects.toBeInstanceOf(CheckoutEngineUnavailableError);

      expect(Date.now() - startedAt).toBeLessThan(RESERVE_WAIT_MS + 1000);
      expect((await readOrder(app, start.orderId))?.status).toBe('RESERVING');
      const run = app.get<Client>(TEMPORAL_CLIENT).workflow.getHandle(checkoutWorkflowId(start.orderId));
      expect((await run.describe()).status.name).toBe('RUNNING');

      await resetCheckoutSagas([app, idleApp]);
      expect((await run.describe()).status.name).toBe('TERMINATED');
    });
  });

  describe('shutdown', () => {
    const SHUTDOWN_ENV = {
      ...WORKER_ON,
      SHUTDOWN_GRACE_PERIOD_MS: '500',
      TEMPORAL_WORKER_SHUTDOWN_GRACE_MS: '500',
      TEMPORAL_WORKER_SHUTDOWN_FORCE_MS: '500',
      QUEUE_WORKER_ENABLED: 'true',
      LOG_LEVEL: 'info',
      TEMPORAL_TASK_QUEUE: temporalTaskQueueForCurrentSpec('shutdown'),
    };
    // Readiness hold, worker grace and force, its slack, two queue-worker waits, and some room.
    const CLOSE_BUDGET_MS = 500 + 500 + 500 + 1000 + 2 * 5000 + 2000;

    it('drains the workflow worker before the queue worker, and the pool only after both', async () => {
      const shutdownApp = (await createTestAppWithPool(SHUTDOWN_ENV)).app;
      try {
        await eventually(
          () => sagaWorker(shutdownApp).status().state,
          (state) => state === 'RUNNING',
        );
        const release = holdCalls(
          shutdownApp.get<OrderInventoryParticipantPort>(ORDER_INVENTORY_PARTICIPANT),
          'release',
        );
        const start = await placeReserving(shutdownApp, 0);
        await expect(sagaEngine(shutdownApp).reserve(start)).resolves.toBe('OUT_OF_STOCK');
        await release.waitForCalls(1);

        // Call-through spies; invocationCallOrder is global across spies, so it orders logs and pool end.
        const info = vi.spyOn(PinoLogger.prototype, 'info');
        const error = vi.spyOn(PinoLogger.prototype, 'error');
        const end = vi.spyOn(shutdownApp.get<Pool>(PG_POOL), 'end');

        const startedAt = Date.now();
        await expect(shutdownApp.close()).resolves.toBeUndefined();
        const tookMs = Date.now() - startedAt;

        const logged = [info, error].flatMap(({ mock }) =>
          mock.calls.map((args, index) => ({ order: mock.invocationCallOrder[index], label: shutdownLabel(args) })),
        );
        const ended = end.mock.invocationCallOrder.map((order) => ({ order, label: 'pool end' }));
        const sequence = [...logged, ...ended]
          .filter(({ label }) => label !== null)
          .sort((a, b) => a.order - b.order)
          .map(({ label }) => label);
        expect(sequence).toEqual([
          'readiness down',
          'grace elapsed',
          'step temporal-worker',
          'step domain-events-worker',
          'pool end',
        ]);
        expect(tookMs).toBeGreaterThanOrEqual(500);
        expect(tookMs).toBeLessThanOrEqual(CLOSE_BUDGET_MS);
      } finally {
        vi.restoreAllMocks();
        releaseHung();
      }
    });
  });
});
