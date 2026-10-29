import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { MESSAGING_QUEUES, QUEUE_CONNECTION } from '../messaging.tokens';

const LOG_CONTEXT = 'QueueLifecycle';

/**
 * BullMQ closes only connections it opened itself — a client handed to it is treated as shared and
 * left running — so owning the client means owning its exit.
 */
@Injectable()
export class QueueLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(MESSAGING_QUEUES) private readonly queues: ReadonlyMap<string, Queue>,
    @Inject(QUEUE_CONNECTION) private readonly queueConnection: Redis,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  // Close at onApplicationShutdown (after the HTTP server has closed) rather than onModuleDestroy,
  // matching the pg pool and RedisService: a request still draining can publish until the very end.
  async onApplicationShutdown(): Promise<void> {
    // Queues first — they can still have commands in flight on the connection underneath them. One
    // failing to close must not leave the others open, so each is closed on its own.
    for (const queue of this.queues.values()) {
      try {
        await queue.close();
      } catch (error) {
        this.logger.error({ queue: queue.name, err: toError(error) }, 'failed to close queue');
      }
    }

    // quit() drains then closes; it rejects immediately when Redis is already gone, so fall back to
    // an unconditional teardown instead of hanging shutdown on an unreachable server.
    try {
      await this.queueConnection.quit();
    } catch {
      this.queueConnection.disconnect();
    }
  }
}
