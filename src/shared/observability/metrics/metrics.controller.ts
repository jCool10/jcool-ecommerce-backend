import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { register } from 'prom-client';
import { ACCOUNT_THROTTLER, DEFAULT_THROTTLER } from '@shared/infrastructure/throttler';
import { Public } from '@shared/rbac';
import { MetricsTokenGuard } from './metrics.guard';

// `@Public()` opts out of the global JwtAuthGuard — auth here is the bearer token in
// MetricsTokenGuard. Throttling is skipped so periodic scrapes neither trip the limit nor cost a
// Redis round-trip; both tiers must be named, since bare `@SkipThrottle()` skips only `default`.
@Public()
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
