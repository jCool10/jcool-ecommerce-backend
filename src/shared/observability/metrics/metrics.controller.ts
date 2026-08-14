import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { register } from 'prom-client';
import { Public } from '@modules/user/interface/decorators';
import { MetricsTokenGuard } from './metrics.guard';

/**
 * The Prometheus scrape endpoint, owned here (not @willsoto's default controller) so its
 * guard resolves in this module's DI scope. `@Public()` opts out of the global JwtAuthGuard —
 * Prometheus authenticates with the metrics bearer token (MetricsTokenGuard), not a user JWT.
 * `@SkipThrottle()` keeps a periodic scrape (or several Prometheus replicas behind one egress
 * IP) from tripping the global rate limit. Serves the process-global prom-client registry.
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
