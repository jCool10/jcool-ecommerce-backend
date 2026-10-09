import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { requireIntConfig } from '@jcool/platform/config';
import { AdvanceCheckoutSagaUseCase } from '../use-cases/advance-checkout-saga.use-case';

const LOG_CONTEXT = 'SagaKickExecutor';
// A kick cut short loses nothing: its lease runs out and the runner takes the saga again.
const DRAIN_TIMEOUT_MS = 5_000;

/**
 * Runs `advance` off the caller's path, so a queue slot never waits on a participant. Every caller
 * has already made the saga due in its own transaction, which is why a dropped kick only costs the
 * delay until the next runner tick.
 */
@Injectable()
export class SagaKickExecutor implements OnModuleDestroy {
  private readonly running = new Set<Promise<void>>();
  private readonly capacity: number;
  private closing = false;

  constructor(
    private readonly advance: AdvanceCheckoutSagaUseCase,
    config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.capacity = requireIntConfig(config, 'saga.kickConcurrency', 1);
    logger.setContext(LOG_CONTEXT);
  }

  submit(orderId: string): void {
    if (this.closing || this.running.size >= this.capacity) {
      this.logger.debug({ orderId, running: this.running.size, closing: this.closing }, 'saga kick dropped');
      return;
    }
    const kick: Promise<void> = this.advance
      .execute(orderId)
      .catch((error: unknown) => {
        this.logger.error({ err: toError(error), orderId }, 'saga kick failed');
      })
      .finally(() => this.running.delete(kick));
    this.running.add(kick);
  }

  async drain(): Promise<void> {
    await Promise.all(this.running);
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    await Promise.race([this.drain(), sleep(DRAIN_TIMEOUT_MS)]);
  }
}

// A pending drain must not hold the process open once the kicks it was racing have finished.
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref());
