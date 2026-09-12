import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@shared/kernel/to-error';

const LOG_CONTEXT = 'RedisService';

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
