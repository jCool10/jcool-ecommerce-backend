import { Injectable, type BeforeApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { runInJobContext } from '@shared/observability/correlation/job-context';
import type { ConsumeResult } from '@shared/observability/metrics/metrics.port';
import { DeadLetterRouter } from './dead-letter';
import type { DomainEventJob } from './domain-event.job';
import { DomainEventProcessor } from './domain-event.processor';
import { createQueueConnection } from './queue-connection';
import { QUEUE_DOMAIN_EVENTS } from './queue.constants';

const LOG_CONTEXT = 'DomainEventsWorker';
// Long enough for a job that is merely slow, short enough that SIGTERM never waits on a dead Redis.
const CLOSE_TIMEOUT_MS = 10_000;

/**
 * Holds no logic of its own on purpose: everything worth asserting lives in the processor, which a
 * test can drive one delivery at a time without a running queue.
 */
@Injectable()
export class DomainEventsWorker implements OnModuleInit, BeforeApplicationShutdown {
  private worker: Worker<DomainEventJob, ConsumeResult> | null = null;
  private connection: Redis | null = null;
  // BullMQ's 'failed' listener is synchronous, so routing to the dead-letter queue outlives the
  // event that triggered it. Tracked because shutdown has to wait for it: worker.close() knows
  // nothing about these, and the queue underneath them is closed moments later.
  private readonly pendingRoutes = new Set<Promise<void>>();

  private readonly enabled: boolean;
  private readonly concurrency: number;
  private readonly prefix: string;
  private readonly redisUrl: string;

  constructor(
    private readonly processor: DomainEventProcessor,
    private readonly deadLetter: DeadLetterRouter,
    config: ConfigService,
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    this.enabled = config.get<boolean>('queue.workerEnabled') === true;
    this.concurrency = config.getOrThrow<number>('queue.workerConcurrency');
    this.prefix = config.getOrThrow<string>('queue.prefix');
    this.redisUrl = config.getOrThrow<string>('redis.url');
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.info({ context: LOG_CONTEXT }, 'domain events worker disabled');
      return;
    }

    // Its own connection, deliberately without the producer's command timeout: a worker parks on a
    // blocking read for the whole poll, so timing that wait out would cut off the design, not a hang.
    this.connection = createQueueConnection(this.redisUrl);
    // One correlation context per delivery, not per worker: at concurrency > 1 several jobs are in
    // flight and without a scope each their lines interleave.
    this.worker = new Worker<DomainEventJob, ConsumeResult>(
      QUEUE_DOMAIN_EVENTS,
      (job) => runInJobContext(this.cls, `${QUEUE_DOMAIN_EVENTS}:${job.name}`, () => this.processor.process(job.data)),
      { connection: this.connection, prefix: this.prefix, concurrency: this.concurrency },
    );

    // An 'error' event with no listener is fatal to the process, and a dropped connection emits one.
    this.worker.on('error', (error: Error) => {
      this.logger.error({ context: LOG_CONTEXT, err: error }, `domain events worker error: ${error.message}`);
    });

    // The listener signature is synchronous, so the route is started rather than awaited; the
    // .catch() keeps a bug inside it from surfacing as an unhandled rejection that kills the process.
    this.worker.on('failed', (job, error: Error) => {
      if (!job) {
        // No job means BullMQ could not load it — nothing to route, and nothing to identify it by.
        this.logger.error({ context: LOG_CONTEXT, err: error }, `domain event consume failed: ${error.message}`);
        return;
      }
      const route = this.deadLetter
        .route(job, error)
        .catch((caught: unknown) => {
          this.logger.error({ context: LOG_CONTEXT, err: caught }, 'dead-letter routing threw');
        })
        .finally(() => this.pendingRoutes.delete(route));
      this.pendingRoutes.add(route);
    });

    this.logger.info({ context: LOG_CONTEXT, concurrency: this.concurrency }, 'domain events worker started');
  }

  // beforeApplicationShutdown, NOT onApplicationShutdown: the pg pool drains in the latter, and Nest
  // orders same-phase hooks by module registration — so sharing that phase would make "the worker
  // stops before the pool closes" a property of import order in app.module.ts rather than of this class.
  async beforeApplicationShutdown(): Promise<void> {
    // Waits for in-flight jobs so a claim never commits into a pool that has already closed. Bounded,
    // because a Redis that is gone would hang shutdown — and losing an in-flight consume costs
    // nothing, since an unapplied event leaves an unclaimed inbox row.
    try {
      await Promise.race([this.worker?.close() ?? Promise.resolve(), timeout(CLOSE_TIMEOUT_MS)]);
    } catch (error: unknown) {
      this.logger.error(
        { context: LOG_CONTEXT, err: error },
        `failed to close domain events worker: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // After the close, because the last job to fail raises 'failed' during it. Returning early here
    // would close the dead-letter queue out from under a move still in flight.
    await Promise.race([Promise.allSettled(this.pendingRoutes), timeout(CLOSE_TIMEOUT_MS)]);

    if (!this.connection) return;
    // quit() rejects outright when Redis is already gone, hence the unconditional fallback.
    try {
      await this.connection.quit();
    } catch {
      this.connection.disconnect();
    }
  }
}

// A pending drain must not hold the process open once the close it was racing has finished.
const timeout = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref());
