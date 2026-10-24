import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Injectable, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NativeConnection, Worker, type WorkerOptions } from '@temporalio/worker';
import { PinoLogger } from 'nestjs-pino';
import { SHUTDOWN_STEP_ORDER, ShutdownService } from '@jcool/platform/health';
import { toError } from '@jcool/kernel';
import type { CheckoutSagaConfig } from '@shared/config/checkout-saga.config';
import { CheckoutSagaActivities } from './checkout-saga.activities';
import { installTemporalRuntime } from './temporal-runtime';
import { CHECKOUT_SAGA_BUNDLE_FILE, checkoutSagaWorkflowsPath } from './workflow-bundle';

const LOG_CONTEXT = 'CheckoutSagaWorker';
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const REPORT_EVERY_MS = 60_000;
// Past grace + force the SDK has already failed every activity still running; this is the slack for
// it to report back before the step moves on.
const STOP_SLACK_MS = 1000;

export type CheckoutSagaWorkerState = 'DISABLED' | 'CONNECTING' | 'RUNNING' | 'BACKOFF' | 'STOPPING' | 'STOPPED';

export interface CheckoutSagaWorkerStatus {
  state: CheckoutSagaWorkerState;
  /** Regular activities only; local ones are counted apart. */
  inFlightActivities: number;
  inFlightLocalActivities: number;
}

class WorkflowBundleMissingError extends Error {
  constructor(readonly bundle: string) {
    super(`Workflow bundle ${bundle} not found; the build writes it`);
    this.name = 'WorkflowBundleMissingError';
  }
}

/**
 * Keeps one Temporal worker running for as long as the app does. Temporal being away never stops the
 * app from booting or serving: the supervisor backs off and tries again until shutdown.
 */
@Injectable()
export class CheckoutSagaWorker implements OnModuleInit, OnApplicationBootstrap {
  private state: CheckoutSagaWorkerState;
  private connection: NativeConnection | null = null;
  private worker: Worker | null = null;
  private supervisor: Promise<void> = Promise.resolve();
  private stopRequested = false;
  private cancelBackoff: () => void = () => undefined;
  private lastReportAt = Number.NEGATIVE_INFINITY;

  private readonly settings: CheckoutSagaConfig;
  private readonly production: boolean;

  constructor(
    private readonly activities: CheckoutSagaActivities,
    config: ConfigService,
    private readonly shutdown: ShutdownService,
    private readonly logger: PinoLogger,
  ) {
    this.settings = config.getOrThrow<CheckoutSagaConfig>('checkoutSaga');
    this.production = config.get<string>('app.env') === 'production';
    this.state = this.settings.temporal.workerEnabled ? 'STOPPED' : 'DISABLED';
    logger.setContext(LOG_CONTEXT);
  }

  onModuleInit(): void {
    if (this.state === 'DISABLED') {
      this.logger.info('checkout saga worker disabled');
      return;
    }
    installTemporalRuntime(this.logger);
    this.shutdown.registerStep({
      name: 'temporal-worker',
      order: SHUTDOWN_STEP_ORDER.DRAIN_WORKFLOW_WORKER,
      run: () => this.stop(),
    });
  }

  onApplicationBootstrap(): void {
    if (this.state === 'DISABLED') return;
    // Not awaited, and it never rejects.
    this.supervisor = this.supervise();
  }

  status(): CheckoutSagaWorkerStatus {
    const status = this.worker?.getStatus();
    return {
      state: this.state,
      inFlightActivities: status?.numInFlightNonLocalActivities ?? 0,
      inFlightLocalActivities: status?.numInFlightLocalActivities ?? 0,
    };
  }

  private async supervise(): Promise<void> {
    let failures = 0;
    while (!this.stopRequested) {
      this.state = 'CONNECTING';
      try {
        await this.connectAndRun(() => (failures = 0));
        if (!this.stopRequested) throw new Error('worker stopped without a shutdown request');
      } catch (error: unknown) {
        if (this.stopRequested) {
          this.logger.warn({ err: toError(error) }, 'temporal worker run failed during shutdown');
        } else {
          this.report(error, failures);
        }
      }
      await this.release();
      if (this.stopRequested) break;
      this.state = 'BACKOFF';
      await this.backoff(workerBackoffMs(failures++));
    }
    this.state = 'STOPPED';
  }

  private async connectAndRun(onRunning: () => void): Promise<void> {
    const workflows = this.workflowSource();
    const { temporal } = this.settings;
    this.connection = await NativeConnection.connect({ address: temporal.address });
    if (this.stopRequested) return;

    this.worker = await Worker.create({
      connection: this.connection,
      namespace: temporal.namespace,
      taskQueue: temporal.taskQueue,
      ...workflows,
      activities: this.activities,
      maxConcurrentActivityTaskExecutions: this.settings.activityConcurrency,
      maxConcurrentLocalActivityExecutions: this.settings.localActivityConcurrency,
      shutdownGraceTime: temporal.workerShutdownGraceMs,
      // The SDK starts the force timer at shutdown(), so it has to cover the grace too.
      shutdownForceTime: temporal.workerShutdownGraceMs + temporal.workerShutdownForceMs,
    });
    // Run even when shutdown came in during create: a worker never run keeps its hold on the connection.
    const running = this.worker.run();
    if (this.stopRequested) {
      this.worker.shutdown();
    } else {
      this.state = 'RUNNING';
      onRunning();
    }
    await running;
  }

  private workflowSource(): Pick<WorkerOptions, 'workflowBundle' | 'workflowsPath'> {
    const { workflowBundlePath } = this.settings.temporal;
    if (workflowBundlePath) return { workflowBundle: { codePath: workflowBundlePath } };
    if (!this.production) return { workflowsPath: checkoutSagaWorkflowsPath() };

    const codePath = resolve(CHECKOUT_SAGA_BUNDLE_FILE);
    if (!existsSync(codePath)) throw new WorkflowBundleMissingError(codePath);
    return { workflowBundle: { codePath } };
  }

  private async stop(): Promise<void> {
    this.stopRequested = true;
    this.state = 'STOPPING';
    this.cancelBackoff();
    if (this.worker?.getState() === 'RUNNING') this.worker.shutdown();

    const { workerShutdownGraceMs, workerShutdownForceMs } = this.settings.temporal;
    await Promise.race([this.supervisor, timeout(workerShutdownGraceMs + workerShutdownForceMs + STOP_SLACK_MS)]);
    // A no-op when the run ended in time; otherwise the close below fails and is only logged.
    await this.release();
  }

  private async release(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.worker = null;
    if (!connection) return;
    try {
      await connection.close();
    } catch (error: unknown) {
      this.logger.warn({ err: toError(error) }, 'temporal worker connection close failed');
    }
  }

  private backoff(ms: number): Promise<void> {
    return new Promise((done) => {
      const timer = setTimeout(done, ms);
      this.cancelBackoff = () => {
        clearTimeout(timer);
        done();
      };
    });
  }

  private report(error: unknown, failures: number): void {
    const now = Date.now();
    if (now - this.lastReportAt < REPORT_EVERY_MS) return;
    this.lastReportAt = now;

    if (error instanceof WorkflowBundleMissingError) {
      this.logger.error({ err: error, bundle: error.bundle }, 'checkout saga worker cannot start without its bundle');
      return;
    }
    this.logger.warn(
      { err: toError(error), failures, address: this.settings.temporal.address },
      'checkout saga worker unavailable; retrying with backoff',
    );
  }
}

/** Doubling from 1s up to 30s, ±20% so replicas that lost Temporal together do not return in step. */
export function workerBackoffMs(failures: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** failures);
  const jittered = base * (0.8 + 0.4 * random());
  return Math.round(Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, jittered)));
}

// Unref'd: a drain that already finished must not hold the process open.
const timeout = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms).unref());
