import { Inject, Injectable, Logger } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../../infrastructure/database';

// Postgres readiness: a `SELECT 1` per call so the result reflects real
// connectivity, not a cached pool state.
@Injectable()
export class DrizzleHealthIndicator {
  private readonly logger = new Logger(DrizzleHealthIndicator.name);

  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    try {
      await this.db.execute(sql`SELECT 1`);
      return indicator.up();
    } catch (error) {
      // Log the raw driver error for operators; keep the client reason generic.
      this.logger.error(`database readiness check failed: ${error instanceof Error ? error.message : String(error)}`);
      return indicator.down({ message: 'database unreachable' });
    }
  }
}
