import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { runInJobContext, withSpan } from '@jcool/platform/observability';
import { SessionEpochReconciler } from '../application/services';

const LOG_CONTEXT = 'SessionEpochReconcileScheduler';
const INTERVAL_NAME = 'session-epoch-reconcile';

/** Owns the timer only; the pass itself is a plain service a test drives directly. */
@Injectable()
export class SessionEpochReconcileScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private running = false;
  private readonly enabled: boolean;
  private readonly intervalMs: number;

  constructor(
    private readonly reconciler: SessionEpochReconciler,
    config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get<boolean>('sessionEpoch.reconcileEnabled') === true;
    // `setInterval(fn, undefined)` fires every event-loop turn; refuse to build that.
    const intervalMs = config.get<number>('sessionEpoch.reconcileIntervalMs');
    if (typeof intervalMs !== 'number' || !Number.isInteger(intervalMs) || intervalMs < 1) {
      throw new Error('Invalid config: sessionEpoch.reconcileIntervalMs must be a positive integer');
    }
    this.intervalMs = intervalMs;
    logger.setContext(LOG_CONTEXT);
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.warn('session epoch reconciler disabled — a lost publish stays lost');
      return;
    }
    this.schedulerRegistry.addInterval(
      INTERVAL_NAME,
      setInterval(() => void this.tick(), this.intervalMs),
    );
  }

  onModuleDestroy(): void {
    if (this.schedulerRegistry.doesExist('interval', INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(INTERVAL_NAME);
    }
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await runInJobContext(this.cls, INTERVAL_NAME, () =>
        withSpan('session-epoch.reconcile', () => this.reconciler.reconcileOnce()),
      );
    } catch (error) {
      // A rejection escaping a timer kills the process.
      this.logger.error({ err: toError(error) }, 'session epoch reconcile pass failed');
    } finally {
      this.running = false;
    }
  }
}
