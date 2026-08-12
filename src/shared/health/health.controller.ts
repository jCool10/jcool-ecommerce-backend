import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckResult, HealthCheckService } from '@nestjs/terminus';
import { Public } from '../../modules/user/interface/decorators/public.decorator';
import { DrizzleHealthIndicator } from './indicators/drizzle.health-indicator';
import { RedisHealthIndicator } from './indicators/redis.health-indicator';

// Liveness/readiness must answer without a token — orchestrators probe these
// unauthenticated. `@Public()` opts the whole controller out of the global guard.
@Public()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly drizzle: DrizzleHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  // Liveness: process responsive? Checks no dependency — a flaky DB/Redis must
  // not make an orchestrator kill a healthy process.
  @Get('live')
  @HealthCheck()
  @ApiOkResponse({ description: 'Process is alive (no dependencies checked).' })
  live(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }

  // Readiness: can we serve traffic? Any dependency down → Terminus 503 naming it.
  @Get('ready')
  @HealthCheck()
  @ApiOkResponse({ description: 'Postgres and Redis are reachable.' })
  @ApiServiceUnavailableResponse({
    description: 'At least one dependency is down.',
  })
  ready(): Promise<HealthCheckResult> {
    return this.health.check([() => this.drizzle.isHealthy('database'), () => this.redis.isHealthy('redis')]);
  }
}
