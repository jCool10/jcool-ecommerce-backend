import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Connection } from '@temporalio/client';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { ReadinessCheckRegistry } from '@jcool/platform/health';
import type { CheckoutSagaConfig } from '../../../../config/checkout-saga.config';
import { CheckoutSagaWorker } from './checkout-saga.worker';
import { TEMPORAL_CONNECTION } from './temporal.providers';

const LOG_CONTEXT = 'TemporalReadinessCheck';
const PROBE_DEADLINE_MS = 1_000;

/**
 * Without Temporal no checkout can start, so the replica is not ready; it still boots and keeps serving
 * reads, and the worker supervisor reconnects on its own. The body says only what is down, the log why.
 */
@Injectable()
export class TemporalReadinessCheck implements OnModuleInit {
  private readonly workerEnabled: boolean;
  private lastFailure: string | null | undefined;

  constructor(
    @Inject(TEMPORAL_CONNECTION) private readonly connection: Connection,
    private readonly worker: CheckoutSagaWorker,
    private readonly registry: ReadinessCheckRegistry,
    config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.workerEnabled = config.getOrThrow<CheckoutSagaConfig>('checkoutSaga').temporal.workerEnabled;
    logger.setContext(LOG_CONTEXT);
  }

  onModuleInit(): void {
    this.registry.register({ name: 'temporal', check: () => this.check() });
  }

  private async check(): Promise<void> {
    try {
      await this.connection.withDeadline(Date.now() + PROBE_DEADLINE_MS, () =>
        this.connection.workflowService.getSystemInfo({}),
      );
    } catch (error: unknown) {
      throw this.down('temporal unreachable', error);
    }
    if (this.workerEnabled) {
      const { state } = this.worker.status();
      if (state !== 'RUNNING') throw this.down(`checkout saga worker is ${state}`);
    }
    if (this.lastFailure !== null) this.logger.info('temporal ready');
    this.lastFailure = null;
  }

  private down(reason: string, cause?: unknown): Error {
    if (this.lastFailure !== reason) {
      this.logger.warn({ reason, ...(cause !== undefined && { err: toError(cause) }) }, 'temporal not ready');
    }
    this.lastFailure = reason;
    return new Error(reason, { cause });
  }
}
