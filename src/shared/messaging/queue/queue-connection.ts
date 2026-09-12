import { Redis, type RedisOptions } from 'ioredis';
import type { PinoLogger } from 'nestjs-pino';
import { toError } from '@shared/kernel/to-error';

const LOG_CONTEXT = 'QueueConnection';

/**
 * Deliberately NOT `RedisService.getClient()`: that one gives up after one retry so a Redis outage
 * falls through to Postgres fast, while a consumer parked on a blocking command (BZPOPMIN) needs an
 * unbounded budget — BullMQ refuses to build on a finite `maxRetriesPerRequest`.
 *
 * The logger is passed in rather than constructed here: this is a plain factory, and a `new Logger()`
 * of its own would be the one connection error in the system that reaches stdout unstructured, with
 * no requestId, job or traceId attached.
 */
export function createQueueConnection(
  url: string,
  logger: PinoLogger,
  overrides: Omit<RedisOptions, 'maxRetriesPerRequest'> = {},
): Redis {
  const connection = new Redis(url, {
    ...overrides,
    // After the overrides, so a connection from this factory is never wrong for the blocking case.
    maxRetriesPerRequest: null,
  });

  // Without an 'error' listener a dropped connection takes the process down; log and let ioredis
  // reconnect, mirroring RedisService.
  connection.on('error', (error: Error) => {
    logger.error({ context: LOG_CONTEXT, err: toError(error) }, 'queue redis connection error');
  });

  return connection;
}
