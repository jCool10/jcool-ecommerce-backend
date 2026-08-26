import { Logger } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';

const logger = new Logger('QueueConnection');

/**
 * A dedicated ioredis client for BullMQ. Deliberately NOT `RedisService.getClient()`: that one gives
 * up after one retry so a Redis outage falls through to Postgres fast, while a consumer parked on a
 * blocking command (BZPOPMIN) needs an unbounded budget — BullMQ refuses to build one otherwise.
 */
export function createQueueConnection(url: string, overrides: Omit<RedisOptions, 'maxRetriesPerRequest'> = {}): Redis {
  const connection = new Redis(url, {
    ...overrides,
    // After the overrides, so a connection from this factory is never wrong for the blocking case.
    maxRetriesPerRequest: null,
  });

  // Without an 'error' listener a dropped connection takes the process down; log and let ioredis
  // reconnect, mirroring RedisService.
  connection.on('error', (error: Error) => {
    logger.error(`Queue Redis connection error: ${error.message}`);
  });

  return connection;
}
