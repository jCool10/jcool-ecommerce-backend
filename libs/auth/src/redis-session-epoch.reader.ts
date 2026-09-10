import { Inject, Injectable } from '@nestjs/common';
import { RedisService } from '@shared/infrastructure/redis';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { authEpochKey } from './auth-epoch.key';
import type { SessionEpochReaderPort } from './session-epoch-reader.port';

@Injectable()
export class RedisSessionEpochReader implements SessionEpochReaderPort {
  constructor(
    private readonly redis: RedisService,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  async current(userId: string): Promise<number | null> {
    const raw = await this.redis.getClient().get(authEpochKey(userId));
    if (raw === null) {
      // Counts both halves of "no projection": a user that is genuinely gone, and a key Redis lost.
      // Only the second is a defect, and only a sustained rate separates them.
      this.metrics.recordAuthEpochProjectionMiss();
      return null;
    }
    const epoch = Number(raw);
    return Number.isInteger(epoch) ? epoch : null;
  }
}
