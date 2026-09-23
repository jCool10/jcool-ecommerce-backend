import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { RedisService } from '../../redis';

const LOG_CONTEXT = 'RedisHealthIndicator';

// Redis readiness: a real PING per call, not ioredis' cached status (which can report "up" while
// commands still fail); enableOfflineQueue=false makes PING reject fast when down, so readiness 503s.
@Injectable()
export class RedisHealthIndicator {
  // Readiness is polled, so only up/down transitions are logged; null until the first check.
  private lastUp: boolean | null = null;

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
        if (this.lastUp !== false) this.logger.error({ reply }, 'redis readiness check got an unexpected ping reply');
        this.lastUp = false;
        return indicator.down({ message: 'redis unreachable' });
      }
      if (this.lastUp === false) this.logger.info('redis readiness recovered');
      this.lastUp = true;
      return indicator.up();
    } catch (error) {
      if (this.lastUp !== false) this.logger.error({ err: toError(error) }, 'redis readiness check failed');
      this.lastUp = false;
      return indicator.down({ message: 'redis unreachable' });
    }
  }
}
