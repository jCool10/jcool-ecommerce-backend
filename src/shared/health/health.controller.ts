import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckResult, HealthCheckService } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { ACCOUNT_THROTTLER, DEFAULT_THROTTLER } from '@shared/infrastructure/throttler';
import { Public } from '@shared/rbac';
import { DrizzleHealthIndicator, RedisHealthIndicator, ShutdownHealthIndicator } from './indicators';

// Liveness/readiness must answer without a token — orchestrators probe these
// unauthenticated. `@Public()` opts the whole controller out of the global guard.
// Probes arrive on a schedule and must never be rate limited: a 429 would pull a healthy
// instance from service, and every tier that stays active costs a Redis round-trip on a
// route whose entire job is to answer when Redis is the thing that's broken.
// Both tiers must be named — bare `@SkipThrottle()` skips only `default`, leaving `account`
// to call Redis on every probe.
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
  ) {}

  // Liveness: process responsive? Checks no dependency — a flaky DB/Redis must
  // not make an orchestrator kill a healthy process.
  @Get('live')
  @HealthCheck()
  @ApiOkResponse({ description: 'Process is alive (no dependencies checked).' })
  live(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }

  // Readiness: can we serve traffic? The shutdown gate is checked first so a draining
  // process 503s immediately (LB stops routing before we close); then any dependency down
  // → Terminus 503 naming it.
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
    ]);
  }
}
