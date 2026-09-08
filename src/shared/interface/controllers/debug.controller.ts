import { Controller, Get, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { ACCOUNT_THROTTLER, DEFAULT_THROTTLER } from '@shared/infrastructure/throttler';
import { Public } from '@shared/rbac';

/**
 * Intentional-error endpoint that exercises the error pipeline end to end: exception filter →
 * structured log → Sentry capture with requestId/traceId.
 */
@Public()
// Both tiers must be named — bare `@SkipThrottle()` skips only `default`, leaving `account`.
@SkipThrottle({ [DEFAULT_THROTTLER]: true, [ACCOUNT_THROTTLER]: true })
@Controller('debug')
export class DebugController {
  constructor(private readonly config: ConfigService) {}

  @Get('boom')
  boom(): never {
    // Fail closed: anything not on the allowlist is a 404, so the route is absent from a real
    // deployment even if the NODE_ENV enum guard is ever loosened.
    const env = this.config.get<string>('app.env');
    if (env !== 'development' && env !== 'test') {
      throw new NotFoundException();
    }
    throw new Error('Intentional boom: verifying the error-tracking pipeline');
  }
}
