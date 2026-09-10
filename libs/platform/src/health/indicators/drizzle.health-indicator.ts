import { Inject, Injectable, Logger } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database';

// A `SELECT 1` per call so readiness reflects real connectivity, not a cached pool state.
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
      this.logger.error(`database readiness check failed: ${error instanceof Error ? error.message : String(error)}`);
      return indicator.down({ message: 'database unreachable' });
    }
  }
}
