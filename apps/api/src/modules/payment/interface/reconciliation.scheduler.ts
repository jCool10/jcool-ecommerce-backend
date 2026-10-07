import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { requireIntConfig } from '@jcool/platform/config';
import { runInJobContext, withSpan } from '@jcool/platform/observability';
import { toError } from '@jcool/kernel';
import {
  ReconcileStaleOrdersUseCase,
  ReconcileTccPaymentsUseCase,
  type ReconcileInput,
  type ReconcileTccInput,
} from '../application/use-cases';

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
  private readonly tccSweep: ReconcileTccInput;

  constructor(
    private readonly reconcileStaleOrders: ReconcileStaleOrdersUseCase,
    private readonly reconcileTccPayments: ReconcileTccPaymentsUseCase,
    config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get<boolean>('reconcile.enabled') === true;
    this.intervalMs = requireIntConfig(config, 'reconcile.intervalMs', 1);
    this.sweep = {
      staleAfterSec: requireIntConfig(config, 'reconcile.staleAfterSec', 0),
      ttlSec: requireIntConfig(config, 'reconcile.orderTtlSec', 0),
      batchSize: requireIntConfig(config, 'reconcile.batchSize', 1),
    };
    this.tccSweep = { staleAfterSec: this.sweep.staleAfterSec, batchSize: this.sweep.batchSize };
    logger.setContext(LOG_CONTEXT);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.info('reconciliation sweep disabled');
      return;
    }
    const timer = setInterval(() => void this.tick(), this.intervalMs);
    this.schedulerRegistry.addInterval(INTERVAL_NAME, timer);
    this.logger.info({ intervalMs: this.intervalMs }, 'reconciliation sweep scheduled');
  }

  onModuleDestroy(): void {
    // Cleared explicitly: a timer surviving shutdown would keep firing against a closed pool.
    if (this.schedulerRegistry.doesExist('interval', INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(INTERVAL_NAME);
    }
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn('previous reconciliation sweep still running — tick skipped');
      return;
    }
    this.running = true;
    try {
      // A timer has no request and no inbound trace: the span puts a trace id on this tick's lines
      // (including the gateway probe auto-instrumentation hangs underneath), the job context puts a
      // correlation id there for readers with no tracing backend.
      await runInJobContext(this.cls, INTERVAL_NAME, () =>
        withSpan('payment.reconcile', async () => {
          await this.runSweep('stale_orders', () => this.reconcileStaleOrders.execute(this.sweep));
          await this.runSweep('tcc_payments', () => this.reconcileTccPayments.execute(this.tccSweep));
        }),
      );
    } catch (error) {
      // An unhandled rejection in a timer kills the process.
      this.logger.error({ err: toError(error) }, 'reconciliation sweep failed');
    } finally {
      this.running = false;
    }
  }

  // Per-item failures are already isolated, so a throw here is the sweep itself breaking; it must not
  // stall the other sweep.
  private async runSweep(sweep: string, run: () => Promise<{ scanned: number }>): Promise<void> {
    try {
      const summary = await run();
      // Idle sweeps are the common case; logging them buries the ticks that did something.
      if (summary.scanned > 0) {
        this.logger.info({ sweep, ...summary }, 'reconciliation sweep completed');
      }
    } catch (error) {
      this.logger.error({ sweep, err: toError(error) }, 'reconciliation sweep failed');
    }
  }
}
