import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@shared/kernel/to-error';
import { DRIZZLE, type DrizzleDB } from '../../infrastructure/database';

const LOG_CONTEXT = 'DrizzleHealthIndicator';

// A `SELECT 1` per call so readiness reflects real connectivity, not a cached pool state.
@Injectable()
export class DrizzleHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    try {
      await this.db.execute(sql`SELECT 1`);
      return indicator.up();
    } catch (error) {
      this.logger.error({ err: toError(error) }, 'database readiness check failed');
      return indicator.down({ message: 'database unreachable' });
    }
  }
}
