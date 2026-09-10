import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { runInJobContext } from '@shared/observability/correlation/job-context';
import { withSpan } from '@shared/observability/tracing/tracer';
import { ReconcileStaleOrdersUseCase, type ReconcileInput } from '../application/use-cases';

const LOG_CONTEXT = 'ReconciliationScheduler';
const INTERVAL_NAME = 'payment-reconcile-stale-orders';

/**
 * Owns the schedule and nothing else, so the sweep stays a plain use case a test can call directly.
 * The interval is registered dynamically rather than via `@Cron`, whose decorator is evaluated long
 * before ConfigService exists. Single-instance by design — replicas stay correct but duplicate
 * gateway calls.
 */
@Injectable()
export class ReconciliationScheduler implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly sweep: ReconcileInput;

  constructor(
    private readonly reconcile: ReconcileStaleOrdersUseCase,
    config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    // A mistyped key reads as undefined, and `setInterval(fn, undefined)` fires every event-loop
    // turn — a busy loop against the gateway. Refuse to build rather than boot that.
    this.enabled = config.get<boolean>('reconcile.enabled') === true;
    this.intervalMs = requireInt(config, 'reconcile.intervalMs', 1);
    this.sweep = {
      staleAfterSec: requireInt(config, 'reconcile.staleAfterSec', 0),
      ttlSec: requireInt(config, 'reconcile.orderTtlSec', 0),
      batchSize: requireInt(config, 'reconcile.batchSize', 1),
    };
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.info({ context: LOG_CONTEXT }, 'reconciliation sweep disabled');
      return;
    }
    const interval = setInterval(() => void this.tick(), this.intervalMs);
    this.schedulerRegistry.addInterval(INTERVAL_NAME, interval);
    this.logger.info({ context: LOG_CONTEXT, intervalMs: this.intervalMs }, 'reconciliation sweep scheduled');
  }

  onModuleDestroy(): void {
    // Cleared explicitly: a timer surviving shutdown would keep firing against a closed pool.
    if (this.schedulerRegistry.doesExist('interval', INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(INTERVAL_NAME);
    }
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn({ context: LOG_CONTEXT }, 'previous reconciliation sweep still running — tick skipped');
      return;
    }
    this.running = true;
    try {
      // A timer has no request and no inbound trace: the span puts a trace id on this tick's lines
      // (including the gateway probe auto-instrumentation hangs underneath), the job context puts a
      // correlation id there for readers with no tracing backend.
      await runInJobContext(this.cls, INTERVAL_NAME, () =>
        withSpan('payment.reconcile', async () => {
          const summary = await this.reconcile.execute(this.sweep);
          // Idle sweeps are the common case; logging them buries the ticks that did something.
          if (summary.scanned > 0) {
            this.logger.info({ context: LOG_CONTEXT, ...summary }, 'reconciliation sweep completed');
          }
        }),
      );
    } catch (error) {
      // Per-order failures are already isolated, so this is the sweep itself breaking. Swallow it:
      // an unhandled rejection in a timer kills the process.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ context: LOG_CONTEXT }, `reconciliation sweep failed: ${message}`);
    } finally {
      this.running = false;
    }
  }
}

function requireInt(config: ConfigService, key: string, min: number): number {
  const value = config.get<number>(key);
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new Error(`Invalid reconciliation config: ${key} must be an integer >= ${min}`);
  }
  return value;
}
