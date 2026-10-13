import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { requireIntConfig } from '@jcool/platform/config';
import { runInJobContext, withSpan } from '@jcool/platform/observability';
import {
  CHECKOUT_SAGA_ENGINE,
  CheckoutEngineUnavailableError,
  checkoutStartFor,
  type CheckoutSagaEnginePort,
} from '../application/ports/checkout-saga-engine.port';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../application/ports/order-repository.port';
import { CHECKOUT_SAGA_SETTINGS, type CheckoutSagaSettings } from '../application/saga/checkout-saga.settings';

const LOG_CONTEXT = 'CheckoutReservingReaperScheduler';
const INTERVAL_NAME = 'order-checkout-reserving-reaper';
const BATCH_SIZE = 50;
const DRAIN_TIMEOUT_MS = 5_000;

/**
 * A RESERVING order this old lost its request before the saga started, or the start never reached
 * Temporal. Starting the saga is enough: it is past its Try budget, so it rejects the order and
 * releases whatever a late Try might hold. Replicas need no leader, the start is idempotent.
 */
@Injectable()
export class CheckoutReservingReaperScheduler implements OnModuleInit, OnModuleDestroy {
  private inFlight: Promise<void> | null = null;
  private stopping = false;
  private readonly enabled: boolean;
  private readonly intervalMs: number;

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepositoryPort,
    @Inject(CHECKOUT_SAGA_ENGINE) private readonly engine: CheckoutSagaEnginePort,
    @Inject(CHECKOUT_SAGA_SETTINGS) private readonly settings: CheckoutSagaSettings,
    config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get<boolean>('checkout.reaperEnabled') === true;
    this.intervalMs = requireIntConfig(config, 'checkout.reaperIntervalMs', 1);
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

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.schedulerRegistry.doesExist('interval', INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(INTERVAL_NAME);
    }
    await Promise.race([this.inFlight ?? Promise.resolve(), sleep(DRAIN_TIMEOUT_MS)]);
  }

  async tick(): Promise<void> {
    if (this.inFlight) {
      this.logger.warn('previous reaper tick still running; tick skipped');
      return;
    }
    this.inFlight = this.run();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async run(): Promise<void> {
    try {
      await runInJobContext(this.cls, INTERVAL_NAME, () =>
        withSpan('checkout_reaper.run', async () => {
          const cutoff = new Date(Date.now() - this.settings.reservingOrphanMs);
          const orphans = await this.orders.findReservingPlacedBefore(cutoff, BATCH_SIZE);
          let failed = 0;
          for (const order of orphans) {
            if (this.stopping) break;
            try {
              await this.engine.ensureStarted(checkoutStartFor(order, this.settings.holdSafetyMs));
            } catch (error) {
              failed++;
              this.logger.error(
                { err: toError(error), orderId: order.id },
                'could not start the saga of a reserving order',
              );
              // Every other order would wait out the same timeout; the next tick picks them up.
              if (error instanceof CheckoutEngineUnavailableError) break;
            }
          }
          if (orphans.length > 0)
            this.logger.warn({ orphans: orphans.length, failed }, 'reserving orders handed to the saga');
        }),
      );
    } catch (error) {
      // An unhandled rejection in a timer kills the process.
      this.logger.error({ err: toError(error) }, 'checkout reserving reaper tick failed');
    }
  }
}

// A pending drain must not hold the process open once the tick it was racing has finished.
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref());
