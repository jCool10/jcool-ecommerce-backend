import { Injectable, type BeforeApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import type { ConsumeResult } from '@shared/observability/metrics/metrics.port';
import type { DomainEventJob } from './domain-event.job';
import { DomainEventProcessor } from './domain-event.processor';
import { createQueueConnection } from './queue-connection';
import { QUEUE_DOMAIN_EVENTS } from './queue.constants';

const LOG_CONTEXT = 'DomainEventsWorker';
// Long enough for a job that is merely slow, short enough that SIGTERM never waits on a dead Redis.
const CLOSE_TIMEOUT_MS = 10_000;

/**
 * Drives the processor from the queue and owns the BullMQ machinery around it: the consumer's own
 * Redis connection, the concurrency budget, and a shutdown that lets in-flight work finish.
 *
 * Holding no logic of its own is the point — everything worth asserting lives in the processor,
 * which a test can drive one delivery at a time.
 */
@Injectable()
export class DomainEventsWorker implements OnModuleInit, BeforeApplicationShutdown {
  private worker: Worker<DomainEventJob, ConsumeResult> | null = null;
  private connection: Redis | null = null;

  private readonly enabled: boolean;
  private readonly concurrency: number;
  private readonly prefix: string;
  private readonly redisUrl: string;

  constructor(
    private readonly processor: DomainEventProcessor,
    config: ConfigService,
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

    // Its own connection, and deliberately without the producer's command timeout: a worker parks on
    // a blocking read for the whole poll, so sharing the producer's client would stall every publish
    // behind it, and timing that wait out would be cutting off the design rather than a hang.
    this.connection = createQueueConnection(this.redisUrl);
    this.worker = new Worker<DomainEventJob, ConsumeResult>(
      QUEUE_DOMAIN_EVENTS,
      (job) => this.processor.process(job.data),
      { connection: this.connection, prefix: this.prefix, concurrency: this.concurrency },
    );

    // An 'error' event with no listener is fatal to the process, and a dropped connection emits one.
    this.worker.on('error', (error: Error) => {
      this.logger.error({ context: LOG_CONTEXT, err: error }, `domain events worker error: ${error.message}`);
    });

    // A failed job is kept by the queue rather than lost, but nothing routes it anywhere yet and it
    // will not be retried — so until a dead-letter path exists, this line is the only signal that an
    // event went unapplied.
    this.worker.on('failed', (job, error: Error) => {
      this.logger.error(
        {
          context: LOG_CONTEXT,
          err: error,
          eventType: job?.name,
          messageId: job?.data?.outboxId,
          attemptsMade: job?.attemptsMade,
        },
        `domain event consume failed: ${error.message}`,
      );
    });

    this.logger.info({ context: LOG_CONTEXT, concurrency: this.concurrency }, 'domain events worker started');
  }

  // beforeApplicationShutdown, NOT onApplicationShutdown: the pg pool drains in the latter, and Nest
  // orders same-phase hooks by module registration — so sharing that phase would make "the worker
  // stops before the pool closes" a property of two import lines in app.module.ts rather than of
  // this class. An earlier phase makes the ordering unconditional.
  async beforeApplicationShutdown(): Promise<void> {
    // Stops fetching and waits for in-flight jobs, so a claim never commits into a pool that has
    // already closed underneath it. A job still waiting is simply picked up by the next process.
    // Bounded, because a Redis that is gone would otherwise hang shutdown indefinitely — losing an
    // in-flight consume costs nothing, since an unapplied event has an unclaimed inbox row.
    try {
      await Promise.race([this.worker?.close() ?? Promise.resolve(), timeout(CLOSE_TIMEOUT_MS)]);
    } catch (error: unknown) {
      this.logger.error(
        { context: LOG_CONTEXT, err: error },
        `failed to close domain events worker: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!this.connection) return;
    // quit() drains then closes, but rejects outright when Redis is already gone — fall back to an
    // unconditional teardown rather than hanging shutdown on an unreachable server.
    try {
      await this.connection.quit();
    } catch {
      this.connection.disconnect();
    }
  }
}

// A pending drain must not hold the process open once the close it was racing has finished.
const timeout = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref());
