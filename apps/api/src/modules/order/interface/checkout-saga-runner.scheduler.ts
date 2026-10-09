import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { requireIntConfig } from '@jcool/platform/config';
import { runInJobContext, withSpan } from '@jcool/platform/observability';
import {
  CHECKOUT_SAGA_REPOSITORY,
  type CheckoutSagaRepositoryPort,
} from '../application/ports/checkout-saga-repository.port';
import { AdvanceCheckoutSagaUseCase } from '../application/use-cases/advance-checkout-saga.use-case';

const LOG_CONTEXT = 'CheckoutSagaRunnerScheduler';
const INTERVAL_NAME = 'order-checkout-saga-runner';
// A tick cut short loses nothing: whatever it had claimed comes back due once its lease runs out.
const DRAIN_TIMEOUT_MS = 5_000;

/**
 * The backstop for every lost kick, crashed request and parked saga. The read takes no lock and
 * claims nothing, so replicas need no leader: `advance`'s own claim decides who works on a saga.
 */
@Injectable()
export class CheckoutSagaRunnerScheduler implements OnModuleInit, OnModuleDestroy {
  private inFlight: Promise<void> | null = null;
  private stopping = false;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;

  constructor(
    @Inject(CHECKOUT_SAGA_REPOSITORY) private readonly sagas: CheckoutSagaRepositoryPort,
    private readonly advance: AdvanceCheckoutSagaUseCase,
    config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get<boolean>('saga.runnerEnabled') === true;
    this.intervalMs = requireIntConfig(config, 'saga.runnerIntervalMs', 1);
    this.batchSize = requireIntConfig(config, 'saga.runnerBatchSize', 1);
    logger.setContext(LOG_CONTEXT);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.info('checkout saga runner disabled');
      return;
    }
    const timer = setInterval(() => void this.tick(), this.intervalMs);
    this.schedulerRegistry.addInterval(INTERVAL_NAME, timer);
    this.logger.info({ intervalMs: this.intervalMs, batchSize: this.batchSize }, 'checkout saga runner scheduled');
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
      this.logger.warn('previous checkout saga runner tick still running; tick skipped');
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
        withSpan('checkout_saga.run', async () => {
          const due = await this.sagas.findDue(this.batchSize);
          let failed = 0;
          for (const orderId of due) {
            if (this.stopping) break;
            try {
              await this.advance.execute(orderId);
            } catch (error) {
              failed++;
              this.logger.error({ err: toError(error), orderId }, 'checkout saga advance failed');
            }
          }
          if (due.length > 0) this.logger.info({ due: due.length, failed }, 'checkout saga runner tick completed');
        }),
      );
    } catch (error) {
      // An unhandled rejection in a timer kills the process.
      this.logger.error({ err: toError(error) }, 'checkout saga runner tick failed');
    }
  }
}

// A pending drain must not hold the process open once the tick it was racing has finished.
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref());
