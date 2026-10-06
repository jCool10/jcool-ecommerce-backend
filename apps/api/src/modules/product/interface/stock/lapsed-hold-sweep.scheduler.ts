import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { requireIntConfig } from '@jcool/platform/config';
import { runInJobContext, withSpan } from '@jcool/platform/observability';
import {
  ReleaseLapsedHoldsUseCase,
  type LapsedHoldSweepInput,
} from '../../application/stock/release-lapsed-holds.use-case';

const LOG_CONTEXT = 'LapsedHoldSweepScheduler';
const INTERVAL_NAME = 'inventory-lapsed-hold-sweep';

// Not `@Cron`: its decorator is evaluated before ConfigService exists.
// Safe on replicas: each release re-checks its header under a row lock.
@Injectable()
export class LapsedHoldSweepScheduler implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly sweep: LapsedHoldSweepInput;

  constructor(
    private readonly releaseLapsedHolds: ReleaseLapsedHoldsUseCase,
    config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get<boolean>('inventory.holdSweep.enabled') === true;
    this.intervalMs = requireIntConfig(config, 'inventory.holdSweep.intervalMs', 1);
    this.sweep = { batchSize: requireIntConfig(config, 'inventory.holdSweep.batchSize', 1) };
    logger.setContext(LOG_CONTEXT);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.info('lapsed hold sweep disabled');
      return;
    }
    const timer = setInterval(() => void this.tick(), this.intervalMs);
    this.schedulerRegistry.addInterval(INTERVAL_NAME, timer);
    this.logger.info({ intervalMs: this.intervalMs }, 'lapsed hold sweep scheduled');
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
          const summary = await this.releaseLapsedHolds.execute(this.sweep);
          // Claims are oldest-first, so an all-failed full batch starves every newer lapsed hold.
          if (summary.scanned === this.sweep.batchSize && summary.errors === summary.scanned) {
            this.logger.error(
              { ...summary, stuck: true },
              'every release in a full lapsed hold batch failed — stock stays held',
            );
          } else if (summary.scanned > 0) {
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
