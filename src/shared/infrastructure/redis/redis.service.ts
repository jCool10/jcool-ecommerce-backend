import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

/**
 * Shared ioredis client, opened at startup and closed on shutdown.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis(config.getOrThrow<string>('redis.url'), {
      // Reject commands while disconnected instead of queueing → readiness fails
      // fast and future cache reads fall through to Postgres rather than hanging.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });

    // Without an 'error' listener a lost connection crashes the process. Log and
    // let ioredis reconnect so boot survives Redis being down.
    this.client.on('error', (err: Error) => {
      this.logger.error(`Redis client error: ${err.message}`);
    });
  }

  /** Underlying client for consumers that need raw commands (cache, locks). */
  getClient(): Redis {
    return this.client;
  }

  /** Liveness probe for the readiness health indicator. Resolves 'PONG'. */
  async ping(): Promise<string> {
    return this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    // quit() drains then closes gracefully; if Redis is unreachable it rejects,
    // so fall back to an immediate teardown to avoid hanging shutdown.
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
