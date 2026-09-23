import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { DRIZZLE, type DrizzleDBOf, type DrizzleSchema } from '../../database';

const LOG_CONTEXT = 'DrizzleHealthIndicator';

// A `SELECT 1` per call so readiness reflects real connectivity, not a cached pool state.
@Injectable()
export class DrizzleHealthIndicator {
  // Readiness is polled, so only up/down transitions are logged; null until the first check.
  private lastUp: boolean | null = null;

  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    @Inject(DRIZZLE) private readonly db: DrizzleDBOf<DrizzleSchema>,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    try {
      await this.db.execute(sql`SELECT 1`);
      if (this.lastUp === false) this.logger.info('database readiness recovered');
      this.lastUp = true;
      return indicator.up();
    } catch (error) {
      if (this.lastUp !== false) this.logger.error({ err: toError(error) }, 'database readiness check failed');
      this.lastUp = false;
      return indicator.down({ message: 'database unreachable' });
    }
  }
}
