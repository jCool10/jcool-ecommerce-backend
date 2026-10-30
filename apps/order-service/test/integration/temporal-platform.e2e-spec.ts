import type { INestApplication } from '@nestjs/common';
import { type Client, Connection } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';
import { type Queue, Worker } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ORDER_EVENTS_QUEUE } from '@jcool/internal-contracts/queues/order-events';
import { type DomainEventJob, DomainEventProcessor, queueToken } from '@jcool/messaging';
import { ShutdownService } from '@jcool/platform/health';
import type { ConsumeResult } from '@jcool/metrics-port';
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
import {
  TEMPORAL_CLIENT,
  TEMPORAL_CONNECTION,
} from '../../src/modules/order/infrastructure/temporal/temporal.providers';
import { PG_POOL } from '../../src/database';
import { authHeader } from '../setup/bearer.helper';
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
import { newPrincipalToken } from '../setup/fixtures/principal.fixture';
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

  it('runs the worker against a live server and reports Temporal ready', async () => {
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
    expect(ready.body.details.temporal).toEqual({ status: 'up' });
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

    // Out of rotation, so no checkout lands on it, but alive and still serving a buyer's order list.
    it('boots not ready and serves reads, with the worker retrying in the background', async () => {
      await request(deadApp.getHttpServer()).get('/health/live').expect(200);
      const ready = await request(deadApp.getHttpServer()).get('/health/ready').expect(503);
      expect(ready.body.error.temporal).toEqual({ status: 'down', message: 'temporal unreachable' });
      expect(['CONNECTING', 'BACKOFF']).toContain(sagaWorker(deadApp).status().state);
      const token = await newPrincipalToken(deadApp);
      await request(deadApp.getHttpServer()).get('/orders').set(authHeader(token)).expect(200);
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
    // Readiness hold, worker grace and force, its slack, the queue-worker wait, and some room.
    const CLOSE_BUDGET_MS = 500 + 500 + 500 + 1000 + 5000 + 2000;
    // Every in-flight saga step finishes on the worker's own connection; the client and the pool go
    // last, once nothing that could still need them is running.
    const STEP_SEQUENCE = [
      'readiness down',
      'grace elapsed',
      'worker connection close',
      'step temporal-worker',
      'step queue-workers',
      'client connection close',
      'pool end',
    ];

    async function shutdownAppWithWorkersRunning(): Promise<INestApplication> {
      const shutdownApp = (await createTestAppWithPool(SHUTDOWN_ENV)).app;
      await eventually(
        () => sagaWorker(shutdownApp).status().state,
        (state) => state === 'RUNNING',
      );
      return shutdownApp;
    }

    async function closeTraced(shutdownApp: INestApplication) {
      // Call-through spies; invocationCallOrder is global across spies, so it orders logs and pool end.
      const info = vi.spyOn(PinoLogger.prototype, 'info');
      const warn = vi.spyOn(PinoLogger.prototype, 'warn');
      const error = vi.spyOn(PinoLogger.prototype, 'error');
      const closes = {
        'worker connection close': vi.spyOn(NativeConnection.prototype, 'close'),
        'client connection close': vi.spyOn(shutdownApp.get<Connection>(TEMPORAL_CONNECTION), 'close'),
        'pool end': vi.spyOn(shutdownApp.get<Pool>(PG_POOL), 'end'),
      };
      const server = shutdownApp.getHttpServer();

      const startedAt = Date.now();
      const closing = shutdownApp.close();
      await eventually(
        () => shutdownApp.get(ShutdownService).isShuttingDown(),
        (draining) => draining,
      );
      const readyWhileDraining = (await request(server).get('/health/ready')).status;
      await expect(closing).resolves.toBeUndefined();
      const tookMs = Date.now() - startedAt;
      const workerWarnings = warn.mock.calls
        .map(([, message]) => message)
        .filter((message) => typeof message === 'string' && message.startsWith('temporal worker'));

      const logged = [info, error].flatMap(({ mock }) =>
        mock.calls.map((args, index) => ({ order: mock.invocationCallOrder[index], label: shutdownLabel(args) })),
      );
      const ended = Object.entries(closes).flatMap(([label, spy]) =>
        spy.mock.invocationCallOrder.map((order) => ({ order, label })),
      );
      const sequence = [...logged, ...ended]
        .filter((entry): entry is { order: number; label: string } => entry.label !== null)
        .sort((a, b) => a.order - b.order)
        .map(({ label }) => label);
      return { sequence, tookMs, readyWhileDraining, workerWarnings };
    }

    it('drains the workflow worker before the queue worker, and the pool only after both', async () => {
      const shutdownApp = await shutdownAppWithWorkersRunning();
      try {
        const release = holdCalls(
          shutdownApp.get<OrderInventoryParticipantPort>(ORDER_INVENTORY_PARTICIPANT),
          'release',
        );
        const start = await placeReserving(shutdownApp, 0);
        await expect(sagaEngine(shutdownApp).reserve(start)).resolves.toBe('OUT_OF_STOCK');
        await release.waitForCalls(1);

        const { sequence, tookMs, readyWhileDraining, workerWarnings } = await closeTraced(shutdownApp);
        expect(readyWhileDraining).toBe(503);
        expect(sequence).toEqual(STEP_SEQUENCE);
        // The held release outlives force shutdown: the run fails and is logged, and close still runs.
        expect(workerWarnings).toEqual(['temporal worker run failed during shutdown']);
        expect(tookMs).toBeGreaterThanOrEqual(500);
        expect(tookMs).toBeLessThanOrEqual(CLOSE_BUDGET_MS);
      } finally {
        vi.restoreAllMocks();
        releaseHung();
      }
    });

    it('lets the order-events worker finish the job it holds before the pool goes', async () => {
      const shutdownApp = await shutdownAppWithWorkersRunning();
      try {
        let finishJob!: () => void;
        const jobFinished = new Promise<ConsumeResult>((resolve) => {
          finishJob = () => resolve('processed');
        });
        let holding = false;
        vi.spyOn(shutdownApp.get(DomainEventProcessor), 'process').mockImplementation(() => {
          holding = true;
          return jobFinished;
        });
        const job: DomainEventJob = {
          outboxId: testId(),
          aggregateType: 'test',
          aggregateId: testId(),
          eventType: 'test.held',
          payload: {},
          occurredAt: new Date().toISOString(),
          traceparent: null,
        };
        await shutdownApp.get<Queue<DomainEventJob>>(queueToken(ORDER_EVENTS_QUEUE)).add(job.eventType, job);
        await eventually(
          () => holding,
          (held) => held,
        );

        const closes: { queue: string; edge: 'start' | 'end' }[] = [];
        // eslint-disable-next-line @typescript-eslint/unbound-method -- called back with the worker as `this`
        const realClose = Worker.prototype.close;
        vi.spyOn(Worker.prototype, 'close').mockImplementation(async function (this: Worker, force?: boolean) {
          closes.push({ queue: this.name, edge: 'start' });
          finishJob();
          await realClose.call(this, force);
          closes.push({ queue: this.name, edge: 'end' });
        });

        const { sequence, tookMs, readyWhileDraining, workerWarnings } = await closeTraced(shutdownApp);
        expect(readyWhileDraining).toBe(503);
        expect(sequence).toEqual(STEP_SEQUENCE);
        expect(workerWarnings).toEqual([]);
        expect(closes).toEqual([
          { queue: ORDER_EVENTS_QUEUE, edge: 'start' },
          { queue: ORDER_EVENTS_QUEUE, edge: 'end' },
        ]);
        // Well inside the order-service's Railway drainingSeconds (30) less a second.
        expect(tookMs).toBeLessThanOrEqual(CLOSE_BUDGET_MS);
      } finally {
        vi.restoreAllMocks();
        releaseHung();
      }
    });
  });
});
