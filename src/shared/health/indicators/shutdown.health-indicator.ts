import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { ShutdownService } from '../shutdown.service';

// Reports "down" once shutdown has begun so load balancers drain this instance before it closes.
// Checked before the DB/Redis indicators so a shutting-down process 503s even while its
// dependencies are still reachable: the point is to stop taking traffic, not to fail a dependency.
@Injectable()
export class ShutdownHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly shutdown: ShutdownService,
  ) {}

  isHealthy(key: string): HealthIndicatorResult {
    const indicator = this.healthIndicatorService.check(key);
    return this.shutdown.isShuttingDown() ? indicator.down({ message: 'shutting down' }) : indicator.up();
  }
}
