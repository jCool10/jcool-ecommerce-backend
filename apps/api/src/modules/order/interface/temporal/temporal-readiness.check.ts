import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Client } from '@temporalio/client';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { ReadinessCheckRegistry, type ReadinessCheck } from '@jcool/platform/health';
import { TEMPORAL_CLIENT } from '../../infrastructure/temporal/temporal.providers';
import { CheckoutSagaWorker } from './checkout-saga.worker';

const PROBE_TIMEOUT_MS = 2_000;

/** Down when the server does not answer, or when this process should be polling and is not. */
@Injectable()
export class TemporalReadinessCheck implements ReadinessCheck, OnModuleInit {
  readonly name = 'temporal';
  // Readiness is polled, so only up/down transitions are logged.
  private lastUp: boolean | null = null;

  constructor(
    @Inject(TEMPORAL_CLIENT) private readonly client: Client,
    private readonly worker: CheckoutSagaWorker,
    private readonly registry: ReadinessCheckRegistry,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext('TemporalReadinessCheck');
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  async isReady(): Promise<boolean> {
    let up = this.worker.isReady();
    let err: Error | undefined;
    if (up) {
      try {
        await this.client.connection.withDeadline(Date.now() + PROBE_TIMEOUT_MS, () =>
          this.client.workflowService.getSystemInfo({}),
        );
      } catch (error) {
        up = false;
        err = toError(error);
      }
    }
    if (up !== this.lastUp) {
      if (up) this.logger.info('temporal readiness up');
      else this.logger.error({ err, workerReady: this.worker.isReady() }, 'temporal readiness down');
    }
    this.lastUp = up;
    return up;
  }
}
