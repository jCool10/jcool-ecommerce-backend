import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { requireIntConfig } from '@jcool/platform/config';
import { runInJobContext, withSpan } from '@jcool/platform/observability';
import { ReleaseLapsedHoldsUseCase } from '../application/release-lapsed-holds.use-case';

const LOG_CONTEXT = 'LapsedHoldSweepScheduler';
const INTERVAL_NAME = 'inventory-lapsed-hold-sweep';

/** Same shape as the order reservation sweep: a dynamic interval, and a disabled sweep has no timer at all. */
@Injectable()
export class LapsedHoldSweepScheduler implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;

  constructor(
    private readonly releaseLapsedHolds: ReleaseLapsedHoldsUseCase,
    config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get<boolean>('inventory.holdSweep.enabled') === true;
    this.intervalMs = requireIntConfig(config, 'inventory.holdSweep.intervalMs', 1);
    this.batchSize = requireIntConfig(config, 'inventory.holdSweep.batchSize', 1);
    logger.setContext(LOG_CONTEXT);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.info('lapsed hold sweep disabled');
      return;
    }
    const timer = setInterval(() => void this.tick(), this.intervalMs);
    this.schedulerRegistry.addInterval(INTERVAL_NAME, timer);
    this.logger.info({ intervalMs: this.intervalMs, batchSize: this.batchSize }, 'lapsed hold sweep scheduled');
  }

  onModuleDestroy(): void {
    if (this.schedulerRegistry.doesExist('interval', INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(INTERVAL_NAME);
    }
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn('previous lapsed hold sweep still running — tick skipped');
      return;
    }
    this.running = true;
    try {
      await runInJobContext(this.cls, INTERVAL_NAME, () =>
        withSpan('inventory.lapsed_hold_sweep', async () => {
          const summary = await this.releaseLapsedHolds.execute({ batchSize: this.batchSize });
          if (summary.scanned > 0) {
            this.logger.info({ ...summary }, 'lapsed hold sweep completed');
          }
        }),
      );
    } catch (error) {
      this.logger.error({ err: toError(error) }, 'lapsed hold sweep failed');
    } finally {
      this.running = false;
    }
  }
}
