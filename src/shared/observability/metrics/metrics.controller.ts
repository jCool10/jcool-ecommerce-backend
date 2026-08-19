import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { register } from 'prom-client';
import { Public } from '@shared/rbac';
import { MetricsTokenGuard } from './metrics.guard';

/**
 * The Prometheus scrape endpoint. `@Public()` opts out of the global JwtAuthGuard (auth is the
 * metrics bearer token via MetricsTokenGuard); `@SkipThrottle()` stops periodic scrapes from
 * tripping the rate limit. Serves the process-global prom-client registry.
 */
@Public()
@SkipThrottle()
@Controller('metrics')
@UseGuards(MetricsTokenGuard)
export class MetricsController {
  @Get()
  async index(@Res() response: Response): Promise<void> {
    response.setHeader('Content-Type', register.contentType);
    response.send(await register.metrics());
  }
}
