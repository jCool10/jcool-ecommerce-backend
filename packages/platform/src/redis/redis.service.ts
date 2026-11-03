import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';

const LOG_CONTEXT = 'RedisService';
// No blocking commands run on this client (BullMQ has its own connection), so every reply is quick.
const REDIS_COMMAND_TIMEOUT_MS = 1_000;

@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly client: Redis;

  constructor(
    config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
    this.client = new Redis(config.getOrThrow<string>('redis.url'), {
      // Reject commands while disconnected instead of queueing, so readiness fails fast and cache
      // reads fall through to Postgres rather than hanging.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      // The offline queue only covers a dropped connection. A connected Redis that stops answering
      // must also fail the command, or every cache read and readiness probe hangs on it.
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    });

    // Without an 'error' listener a lost connection crashes the process; log and let ioredis
    // reconnect so boot survives Redis being down.
    this.client.on('error', (err: Error) => {
      this.logger.error({ err: toError(err) }, 'redis client error');
    });
  }

  getClient(): Redis {
    return this.client;
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }

  // onApplicationShutdown (after the HTTP server closed), not onModuleDestroy (before it): the
  // client stays available through the readiness-drain window so in-flight and just-drained
  // requests still resolve, matching the pg pool's teardown timing.
  async onApplicationShutdown(): Promise<void> {
    // quit() rejects when Redis is unreachable, so fall back to an immediate teardown rather than
    // hanging shutdown.
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
