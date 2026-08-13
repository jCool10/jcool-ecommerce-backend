import { Injectable, Logger } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { RedisService } from '../../infrastructure/redis/redis.service';

// Redis readiness: a real PING per call, not ioredis' cached status (which can report "up" while
// commands still fail); enableOfflineQueue=false makes PING reject fast when down, so readiness 503s.
@Injectable()
export class RedisHealthIndicator {
  private readonly logger = new Logger(RedisHealthIndicator.name);

  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly redis: RedisService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    try {
      const reply = await this.redis.ping();
      if (reply !== 'PONG') {
        this.logger.error(`redis readiness check: unexpected ping reply ${reply}`);
        return indicator.down({ message: 'redis unreachable' });
      }
      return indicator.up();
    } catch (error) {
      // Log the raw error for operators; keep the client body generic.
      this.logger.error(`redis readiness check failed: ${error instanceof Error ? error.message : String(error)}`);
      return indicator.down({ message: 'redis unreachable' });
    }
  }
}
