import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@shared/kernel/to-error';
import { RedisService } from '../../infrastructure/redis';

const LOG_CONTEXT = 'RedisHealthIndicator';

// Redis readiness: a real PING per call, not ioredis' cached status (which can report "up" while
// commands still fail); enableOfflineQueue=false makes PING reject fast when down, so readiness 503s.
@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    try {
      const reply = await this.redis.ping();
      if (reply !== 'PONG') {
        this.logger.error({ reply }, 'redis readiness check got an unexpected ping reply');
        return indicator.down({ message: 'redis unreachable' });
      }
      return indicator.up();
    } catch (error) {
      this.logger.error({ err: toError(error) }, 'redis readiness check failed');
      return indicator.down({ message: 'redis unreachable' });
    }
  }
}
