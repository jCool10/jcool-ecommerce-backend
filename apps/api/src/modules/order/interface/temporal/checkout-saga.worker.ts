import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy, type Provider } from '@nestjs/common';
import {
  CombinedWorkerRunError,
  DefaultLogger,
  GracefulShutdownPeriodExpiredError,
  IllegalStateError,
  NativeConnection,
  Runtime,
  Worker,
  type LogLevel,
  type WorkerOptions,
} from '@temporalio/worker';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { IDEMPOTENCY_STORE, type IdempotencyStorePort } from '../../application/ports/idempotency-store.port';
import { INVENTORY_TCC, type InventoryTccPort } from '../../application/ports/inventory-participant.port';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../../application/ports/order-repository.port';
import { PAYMENT_TCC, type PaymentTccPort } from '../../application/ports/payment-participant.port';
import { CheckoutOrderWriter } from '../../application/saga/checkout-order.writer';
import { TEMPORAL_SETTINGS, type TemporalSettings } from '../../infrastructure/temporal/temporal.providers';
import {
  createCheckoutSagaActivities,
  type CheckoutSagaActivities,
} from '../../saga/activities/checkout-saga.activities';

export const CHECKOUT_SAGA_ACTIVITIES = Symbol('CHECKOUT_SAGA_ACTIVITIES');

export const checkoutSagaActivitiesProvider: Provider = {
  provide: CHECKOUT_SAGA_ACTIVITIES,
  inject: [INVENTORY_TCC, PAYMENT_TCC, CheckoutOrderWriter, ORDER_REPOSITORY, IDEMPOTENCY_STORE, METRICS, PinoLogger],
  useFactory: (
    inventory: InventoryTccPort,
    payment: PaymentTccPort,
    writer: CheckoutOrderWriter,
    orders: OrderRepositoryPort,
    idempotencyStore: IdempotencyStorePort,
    metrics: MetricsPort,
    logger: PinoLogger,
  ): CheckoutSagaActivities => {
    logger.setContext('CheckoutSagaActivities');
    return createCheckoutSagaActivities({ inventory, payment, writer, orders, idempotencyStore, metrics, logger });
  },
};

const LOG_CONTEXT = 'CheckoutSagaWorker';
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;
const FORCE_SHUTDOWN_SLACK_MS = 5_000;
const WORKFLOWS_PATH = resolve(__dirname, '../../saga/workflows');

/**
 * Runs in the api process. Boot never waits on Temporal: the worker connects in the background and
 * keeps reconnecting, and readiness reports down until it polls.
 */
@Injectable()
export class CheckoutSagaWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly stopping = new AbortController();
  private worker: Worker | null = null;
  private lifecycle: Promise<void> = Promise.resolve();

  constructor(
    @Inject(TEMPORAL_SETTINGS) private readonly settings: TemporalSettings,
    @Inject(CHECKOUT_SAGA_ACTIVITIES) private readonly activities: CheckoutSagaActivities,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  onApplicationBootstrap(): void {
    if (!this.settings.workerEnabled) {
      this.logger.info('checkout saga worker disabled');
      return;
    }
    // Resolved here so a production image without its bundle fails the boot, not every reconnect.
    const workflows = this.workflowSource();
    installRuntime(this.logger);
    this.lifecycle = this.keepRunning(workflows);
  }

  /** A process with the worker turned off has no saga work to be ready for. */
  isReady(): boolean {
    return !this.settings.workerEnabled || this.worker?.getState() === 'RUNNING';
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping.abort();
    if (this.worker?.getState() === 'RUNNING') this.worker.shutdown();
    await this.lifecycle;
  }

  private async keepRunning(workflows: Pick<WorkerOptions, 'workflowBundle' | 'workflowsPath'>): Promise<void> {
    for (let attempt = 0; !this.stopping.signal.aborted; attempt++) {
      try {
        await this.runOnce(workflows, () => {
          attempt = 0;
        });
      } catch (error) {
        if (isForcedShutdown(error)) {
          this.logger.warn('checkout saga worker outlived its shutdown grace; abandoning its running activities');
          return;
        }
        this.logger.warn({ err: toError(error), attempt }, 'checkout saga worker is not running; reconnecting');
      }
      const backoffMs = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 10));
      await sleep(backoffMs, undefined, { signal: this.stopping.signal }).catch(() => undefined);
    }
  }

  private async runOnce(
    workflows: Pick<WorkerOptions, 'workflowBundle' | 'workflowsPath'>,
    onPolling: () => void,
  ): Promise<void> {
    const { address, namespace, taskQueue, activityConcurrency, workerShutdownGraceMs } = this.settings;
    const connection = await NativeConnection.connect({ address });
    let connectionHeld = false;
    try {
      const worker = await Worker.create({
        connection,
        namespace,
        taskQueue,
        activities: this.activities,
        ...workflows,
        maxConcurrentActivityTaskExecutions: activityConcurrency,
        shutdownGraceTime: workerShutdownGraceMs,
        // Without it one hung activity keeps `run()` pending and the process never exits.
        shutdownForceTime: workerShutdownGraceMs + FORCE_SHUTDOWN_SLACK_MS,
      });
      const running = worker.run();
      this.worker = worker;
      if (this.stopping.signal.aborted) {
        worker.shutdown();
      } else {
        this.logger.info({ namespace, taskQueue }, 'checkout saga worker polling');
        onPolling();
      }
      await running;
    } catch (error) {
      // The forced worker still holds the connection, and closing it under the worker throws.
      connectionHeld = isForcedShutdown(error);
      throw error;
    } finally {
      this.worker = null;
      if (!connectionHeld) await connection.close();
    }
  }

  private workflowSource(): Pick<WorkerOptions, 'workflowBundle' | 'workflowsPath'> {
    const codePath = resolve(this.settings.workflowBundlePath);
    if (existsSync(codePath)) return { workflowBundle: { codePath } };
    if (this.settings.workflowBundleRequired) {
      throw new Error(`Prebuilt workflow bundle not found at ${codePath}`);
    }
    this.logger.warn({ codePath }, 'no prebuilt workflow bundle; bundling the workflows at startup');
    return { workflowsPath: WORKFLOWS_PATH };
  }
}

function isForcedShutdown(error: unknown): boolean {
  return (
    error instanceof GracefulShutdownPeriodExpiredError ||
    (error instanceof CombinedWorkerRunError && error.cause.workerError instanceof GracefulShutdownPeriodExpiredError)
  );
}

const LOG_METHODS: Record<LogLevel, 'trace' | 'debug' | 'info' | 'warn' | 'error'> = {
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
};

let runtimeInstalled = false;

function installRuntime(logger: PinoLogger): void {
  if (runtimeInstalled) return;
  runtimeInstalled = true;
  try {
    Runtime.install({
      // Nest owns SIGTERM and shuts the worker down from onModuleDestroy, in order with the DB pool.
      shutdownSignals: [],
      logger: new DefaultLogger('WARN', ({ level, message, meta }) => logger[LOG_METHODS[level]]({ ...meta }, message)),
    });
  } catch (error) {
    // Another runtime got there first (a test environment); its logger is good enough.
    if (!(error instanceof IllegalStateError)) throw error;
  }
}
