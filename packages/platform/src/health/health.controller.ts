import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  type HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { ACCOUNT_THROTTLER, DEFAULT_THROTTLER } from '../throttler';
import { Public } from '../rbac';
import { DrizzleHealthIndicator, RedisHealthIndicator, ShutdownHealthIndicator } from './indicators';
import { type ReadinessCheck, ReadinessCheckRegistry } from './readiness-check.registry';

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
    private readonly drizzleHealth: DrizzleHealthIndicator,
    private readonly redisHealth: RedisHealthIndicator,
    private readonly shutdownHealth: ShutdownHealthIndicator,
    private readonly indicators: HealthIndicatorService,
    private readonly registry: ReadinessCheckRegistry,
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
      () => this.shutdownHealth.isHealthy('shutdown'),
      () => this.drizzleHealth.isHealthy('database'),
      () => this.redisHealth.isHealthy('redis'),
      ...this.registry.all().map((check) => () => this.run(check)),
    ]);
  }

  private async run({ name, check }: ReadinessCheck): Promise<HealthIndicatorResult> {
    const indicator = this.indicators.check(name);
    try {
      await check();
      return indicator.up();
    } catch (error: unknown) {
      return indicator.down({ message: error instanceof Error ? error.message : String(error) });
    }
  }
}
