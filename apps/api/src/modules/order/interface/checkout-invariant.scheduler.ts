import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { runInJobContext, withSpan } from '@jcool/platform/observability';
import type { CheckoutSagaConfig } from '@shared/config/checkout-saga.config';
import { RunCheckoutInvariantsUseCase } from '../application/use-cases';

const LOG_CONTEXT = 'CheckoutInvariantChecker';
const INTERVAL_NAME = 'checkout-invariant-checker';

/** Read-only, so every replica may run it; each just sets the same gauges. */
@Injectable()
export class CheckoutInvariantScheduler implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private readonly enabled: boolean;
  private readonly intervalMs: number;

  constructor(
    private readonly runCheckoutInvariants: RunCheckoutInvariantsUseCase,
    config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    const { invariant } = config.getOrThrow<CheckoutSagaConfig>('checkoutSaga');
    this.enabled = invariant.enabled;
    this.intervalMs = invariant.intervalMs;
    logger.setContext(LOG_CONTEXT);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.info('checkout invariant checker disabled');
      return;
    }
    const timer = setInterval(() => void this.tick(), this.intervalMs);
    this.schedulerRegistry.addInterval(INTERVAL_NAME, timer);
    this.logger.info({ intervalMs: this.intervalMs }, 'checkout invariant checker scheduled');
  }

  onModuleDestroy(): void {
    if (this.schedulerRegistry.doesExist('interval', INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(INTERVAL_NAME);
    }
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn('previous invariant check still running, tick skipped');
      return;
    }
    this.running = true;
    try {
      await runInJobContext(this.cls, INTERVAL_NAME, () =>
        withSpan('checkout.invariant_check', async () => {
          const { result, checked } = await this.runCheckoutInvariants.execute();
          this.logger.info({ result, checked }, 'checkout invariant check finished');
        }),
      );
    } catch (error) {
      this.logger.error({ err: toError(error) }, 'checkout invariant checker tick failed');
    } finally {
      this.running = false;
    }
  }
}
