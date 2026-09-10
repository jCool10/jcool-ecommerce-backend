import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckResult, HealthCheckService } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { ACCOUNT_THROTTLER, DEFAULT_THROTTLER } from '@shared/infrastructure/throttler';
import { Public } from '@shared/rbac';
import {
  DrizzleHealthIndicator,
  LeaseHealthIndicator,
  RedisHealthIndicator,
  ShutdownHealthIndicator,
} from './indicators';

// Probes are unauthenticated and arrive on a schedule: a 429 would pull a healthy instance from
// service, and every tier left active costs a Redis round-trip on the route whose whole job is to
// answer when Redis is what's broken. Both tiers are named — bare `@SkipThrottle()` skips only
// `default`, leaving `account` to call Redis on every probe.
@Public()
@SkipThrottle({ [DEFAULT_THROTTLER]: true, [ACCOUNT_THROTTLER]: true })
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly drizzle: DrizzleHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly shutdown: ShutdownHealthIndicator,
    private readonly lease: LeaseHealthIndicator,
  ) {}

  // Checks no dependency: a flaky DB/Redis must not make an orchestrator kill a healthy process.
  @Get('live')
  @HealthCheck()
  @ApiOkResponse({ description: 'Process is alive (no dependencies checked).' })
  live(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }

  @Get('ready')
  @HealthCheck()
  @ApiOkResponse({ description: 'Not shutting down; Postgres and Redis are reachable.' })
  @ApiServiceUnavailableResponse({
    description: 'Shutting down, or at least one dependency is down.',
  })
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.shutdown.isHealthy('shutdown'),
      () => this.drizzle.isHealthy('database'),
      () => this.redis.isHealthy('redis'),
      () => this.lease.isHealthy('nodeLease'),
    ]);
  }
}
