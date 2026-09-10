import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { authEpochKey } from '@shared/auth';
import { RedisService } from '@shared/infrastructure/redis';
import { durationToMs } from '@shared/kernel';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import type { SessionEpochProjectionPort } from '../application/ports';

@Injectable()
export class RedisSessionEpochProjection implements SessionEpochProjectionPort {
  private readonly logger = new Logger(RedisSessionEpochProjection.name);
  private readonly ttlMs: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {
    this.ttlMs = durationToMs(config.getOrThrow<string>('auth.epochProjectionTtl'));
  }

  async publish(userId: string, epoch: number): Promise<void> {
    await this.write(userId, (client, key) => client.set(key, String(epoch), 'PX', this.ttlMs));
  }

  async revoke(userId: string): Promise<void> {
    await this.write(userId, (client, key) => client.del(key));
  }

  // Never throws: the caller has already committed to Postgres, and failing the request there would
  // undo nothing. The counter is what makes the resulting delay visible.
  private async write(
    userId: string,
    command: (client: ReturnType<RedisService['getClient']>, key: string) => Promise<unknown>,
  ): Promise<void> {
    try {
      await command(this.redis.getClient(), authEpochKey(userId));
    } catch (error) {
      this.metrics.recordAuthEpochProjectionWriteFailure();
      this.logger.error(`Session-epoch projection write failed for ${userId}: ${(error as Error).message}`);
    }
  }
}
