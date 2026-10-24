import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { runInJobContext, withSpan } from '@jcool/platform/observability';
import type { CheckoutSagaConfig } from '@shared/config/checkout-saga.config';
import { ReapReservingOrdersUseCase } from '../application/use-cases';

const LOG_CONTEXT = 'CheckoutReservingReaper';
const INTERVAL_NAME = 'checkout-reserving-reaper';

/**
 * Registered at init rather than with `@Interval`, whose decorator runs before config exists. Safe on
 * replicas: a second `ensureStarted` for the same order is a no-op on the open run.
 */
@Injectable()
export class CheckoutReservingReaperScheduler implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private readonly enabled: boolean;
  private readonly intervalMs: number;

  constructor(
    private readonly reapReservingOrders: ReapReservingOrdersUseCase,
    config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    const { reaper } = config.getOrThrow<CheckoutSagaConfig>('checkoutSaga');
    this.enabled = reaper.enabled;
    this.intervalMs = reaper.intervalMs;
    logger.setContext(LOG_CONTEXT);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.info('checkout reserving reaper disabled');
      return;
    }
    const timer = setInterval(() => void this.tick(), this.intervalMs);
    this.schedulerRegistry.addInterval(INTERVAL_NAME, timer);
    this.logger.info({ intervalMs: this.intervalMs }, 'checkout reserving reaper scheduled');
  }

  onModuleDestroy(): void {
    if (this.schedulerRegistry.doesExist('interval', INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(INTERVAL_NAME);
    }
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn('previous reaper tick still running, tick skipped');
      return;
    }
    this.running = true;
    try {
      await runInJobContext(this.cls, INTERVAL_NAME, () =>
        withSpan('checkout.reaper', async () => {
          const summary = await this.reapReservingOrders.execute();
          if (summary.found > 0) this.logger.info({ ...summary }, 'reaper handed orphaned orders back to their sagas');
        }),
      );
    } catch (error) {
      this.logger.error({ err: toError(error) }, 'checkout reserving reaper tick failed');
    } finally {
      this.running = false;
    }
  }
}
