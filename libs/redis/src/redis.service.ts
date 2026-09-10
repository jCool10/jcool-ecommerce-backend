import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis(config.getOrThrow<string>('redis.url'), {
      // Reject commands while disconnected instead of queueing, so readiness fails fast and cache
      // reads fall through to Postgres rather than hanging.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });

    // Without an 'error' listener a lost connection crashes the process; log and let ioredis
    // reconnect so boot survives Redis being down.
    this.client.on('error', (err: Error) => {
      this.logger.error(`Redis client error: ${err.message}`);
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
