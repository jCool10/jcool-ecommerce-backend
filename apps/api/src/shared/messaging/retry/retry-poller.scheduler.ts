import { Injectable, type BeforeApplicationShutdown, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { requireIntConfig } from '@jcool/platform/config';
import { runInJobContext } from '@jcool/platform/observability';
import { toError } from '@jcool/kernel';
import { RetryPoller } from './retry-poller';

const LOG_CONTEXT = 'RetryPollerScheduler';
const INTERVAL_NAME = 'messaging-retry-poller';
// Matches the worker's close budget: an attempt in flight is a handler run, not a single statement.
const DRAIN_TIMEOUT_MS = 10_000;

@Injectable()
export class RetryPollerScheduler implements OnModuleInit, OnModuleDestroy, BeforeApplicationShutdown {
  private inFlight: Promise<void> | null = null;
  private readonly shutdown = new AbortController();
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;

  constructor(
    private readonly poller: RetryPoller,
    config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    // Tied to the worker flag so an instance with consumption switched off runs no handler at all.
    this.enabled =
      config.get<boolean>('messaging.retry.enabled') === true && config.get<boolean>('queue.workerEnabled') === true;
    this.intervalMs = requireIntConfig(config, 'messaging.retry.pollMs', 1);
    this.batchSize = requireIntConfig(config, 'messaging.retry.batchSize', 1);
    logger.setContext(LOG_CONTEXT);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.info('consumer retry poller disabled');
      return;
    }
    const timer = setInterval(() => void this.tick(), this.intervalMs);
    this.schedulerRegistry.addInterval(INTERVAL_NAME, timer);
    this.logger.info({ intervalMs: this.intervalMs, batchSize: this.batchSize }, 'consumer retry poller scheduled');
  }

  onModuleDestroy(): void {
    if (this.schedulerRegistry.doesExist('interval', INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(INTERVAL_NAME);
    }
    this.shutdown.abort();
  }

  // Every onModuleDestroy runs before any beforeApplicationShutdown, so draining in the former would
  // queue this wait in front of the readiness grace and the worker's close instead of beside them.
  async beforeApplicationShutdown(): Promise<void> {
    await Promise.race([this.inFlight ?? Promise.resolve(), sleep(DRAIN_TIMEOUT_MS)]);
  }

  async tick(): Promise<void> {
    if (this.inFlight) {
      this.logger.warn('previous consumer retry tick still running — tick skipped');
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
      await runInJobContext(this.cls, INTERVAL_NAME, async () => {
        const summary = await this.poller.runOnce(this.batchSize, this.shutdown.signal);
        if (summary.leased > 0) this.logger.info({ ...summary }, 'consumer retry tick completed');
      });
    } catch (error) {
      this.logger.error({ err: toError(error) }, 'consumer retry tick failed');
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref());
