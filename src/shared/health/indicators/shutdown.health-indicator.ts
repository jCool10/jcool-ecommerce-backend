import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { ShutdownService } from '../shutdown.service';

// Readiness gate for graceful shutdown: reports "down" once shutdown has begun so Terminus
// returns 503 and load balancers drain this instance before it closes. Checked before the
// DB/Redis indicators so a shutting-down process 503s even while its dependencies are still
// reachable (the point is to stop taking traffic, not to prove a dependency failed).
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
