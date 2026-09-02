import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { register } from 'prom-client';
import { ACCOUNT_THROTTLER, DEFAULT_THROTTLER } from '@shared/infrastructure/throttler';
import { Public } from '@shared/rbac';
import { MetricsTokenGuard } from './metrics.guard';

/**
 * The Prometheus scrape endpoint. `@Public()` opts out of the global JwtAuthGuard (auth is the
 * metrics bearer token via MetricsTokenGuard); skipping the throttler stops periodic scrapes from
 * tripping the rate limit, and spares every scrape a Redis round-trip. Serves the process-global
 * prom-client registry.
 */
@Public()
// Both tiers must be named — bare `@SkipThrottle()` skips only `default`, leaving `account`.
@SkipThrottle({ [DEFAULT_THROTTLER]: true, [ACCOUNT_THROTTLER]: true })
@Controller('metrics')
@UseGuards(MetricsTokenGuard)
export class MetricsController {
  @Get()
  async index(@Res() response: Response): Promise<void> {
    response.setHeader('Content-Type', register.contentType);
    response.send(await register.metrics());
  }
}
