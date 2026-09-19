import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { createQueueConnection } from './queue-connection';
import {
  buildJobOptions,
  DOMAIN_EVENTS_DLQ_QUEUE,
  DOMAIN_EVENTS_QUEUE,
  QUEUE_CONNECTION,
  QUEUE_DOMAIN_EVENTS,
  QUEUE_DOMAIN_EVENTS_DLQ,
} from './queue.constants';

/**
 * Producer side only. A consumer gets its own connection: a worker's blocking read holds one open
 * for the whole poll, so sharing would stall every publish behind it.
 */
export const QUEUE_PROVIDERS: Provider[] = [
  {
    provide: QUEUE_CONNECTION,
    inject: [ConfigService, PinoLogger],
    useFactory: (config: ConfigService, logger: PinoLogger): Redis =>
      createQueueConnection(config.getOrThrow<string>('redis.url'), logger, {
        // Reject a publish while disconnected instead of buffering it in memory: the outbox row is
        // the durable buffer, whereas an offline queue would accept a publish that dies with the process.
        enableOfflineQueue: false,
        // That only covers commands not yet sent. `maxRetriesPerRequest: null` makes one already on
        // the wire wait unboundedly, and the relay publishes inside a transaction, so an outage would
        // pin row locks for its whole duration. Producer-only: a consumer's blocking read must wait.
        commandTimeout: 5_000,
      }),
  },
  {
    provide: DOMAIN_EVENTS_QUEUE,
    inject: [QUEUE_CONNECTION, ConfigService],
    useFactory: (connection: Redis, config: ConfigService): Queue =>
      new Queue(QUEUE_DOMAIN_EVENTS, {
        connection,
        // Namespaces every key, so one Redis can host several environments without their queues
        // reading each other's jobs.
        prefix: config.getOrThrow<string>('queue.prefix'),
        // Configured rather than baked in, so a suite can collapse the backoff to milliseconds and
        // still exercise the real retry path.
        defaultJobOptions: buildJobOptions(
          config.getOrThrow<number>('queue.consumerAttempts'),
          config.getOrThrow<number>('queue.consumerBackoffMs'),
        ),
      }),
  },
  {
    provide: DOMAIN_EVENTS_DLQ_QUEUE,
    inject: [QUEUE_CONNECTION, ConfigService],
    useFactory: (connection: Redis, config: ConfigService): Queue =>
      // No default job options on purpose: nothing consumes this queue, so retention rules would
      // quietly delete the very record it exists to keep. A dead-letter job leaves only by being
      // replayed or dropped by hand.
      new Queue(QUEUE_DOMAIN_EVENTS_DLQ, { connection, prefix: config.getOrThrow<string>('queue.prefix') }),
  },
];
