import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { MESSAGING_QUEUES, QUEUE_CONNECTION, queueToken } from '../messaging.tokens';
import { destinationsOf, type EventRoutes } from '../routing/event-routes';
import { createQueueConnection } from './queue-connection';
import type { QueueDefinition, QueueSpec } from './queue-definition';
import { buildJobOptions } from './queue-options';

/**
 * Producer side only. A consumer gets its own connection: a worker's blocking read holds one open
 * for the whole poll, so sharing would stall every publish behind it.
 */
const connectionProvider: Provider = {
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
};

/** Every queue this process publishes to or consumes, and the dead-letter queue of each it consumes. */
export function queueNamesOf(routes: EventRoutes, consumed: QueueDefinition[]): { main: string[]; dlq: string[] } {
  const main = new Map<string, QueueSpec>(destinationsOf(routes).map((spec) => [spec.name, spec]));
  for (const definition of consumed) {
    const routed = main.get(definition.name);
    if (routed && routed.dlq !== definition.dlq) {
      throw new Error(`queue ${definition.name} is routed to ${routed.dlq} but consumed with ${definition.dlq}`);
    }
    main.set(definition.name, definition);
  }
  return { main: [...main.keys()], dlq: consumed.map((definition) => definition.dlq) };
}

export function queueProviders(routes: EventRoutes, consumed: QueueDefinition[]): Provider[] {
  const { main, dlq } = queueNamesOf(routes, consumed);

  return [
    connectionProvider,
    {
      provide: MESSAGING_QUEUES,
      inject: [QUEUE_CONNECTION, ConfigService],
      useFactory: (connection: Redis, config: ConfigService): ReadonlyMap<string, Queue> => {
        // Namespaces every key, so one Redis can host several environments without their queues
        // reading each other's jobs.
        const prefix = config.getOrThrow<string>('queue.prefix');
        // Configured rather than baked in, so a suite can collapse the backoff to milliseconds and
        // still exercise the real retry path.
        const defaultJobOptions = buildJobOptions(
          config.getOrThrow<number>('queue.consumerAttempts'),
          config.getOrThrow<number>('queue.consumerBackoffMs'),
        );
        return new Map([
          ...main.map((name): [string, Queue] => [name, new Queue(name, { connection, prefix, defaultJobOptions })]),
          // No default job options on purpose: nothing consumes a dead-letter queue, so retention rules
          // would quietly delete the very record it exists to keep. A job leaves only by being
          // replayed or dropped by hand.
          ...dlq.map((name): [string, Queue] => [name, new Queue(name, { connection, prefix })]),
        ]);
      },
    },
    ...[...main, ...dlq].map((name): Provider => ({
      provide: queueToken(name),
      inject: [MESSAGING_QUEUES],
      useFactory: (queues: ReadonlyMap<string, Queue>) => queues.get(name),
    })),
  ];
}
