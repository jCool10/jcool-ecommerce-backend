import { Controller, Get, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '@shared/rbac';

/**
 * Intentional-error endpoint for exercising the error pipeline end to end (exception filter →
 * structured log → Sentry capture with requestId/traceId). `@Public()` opts out of the global
 * JwtAuthGuard so it is reachable without a token; `@SkipThrottle()` keeps repeated checks off the
 * rate limiter. Reachable only in the known non-prod envs so it never exists in a real deployment.
 * See ADR-0016.
 */
@Public()
@SkipThrottle()
@Controller('debug')
export class DebugController {
  constructor(private readonly config: ConfigService) {}

  @Get('boom')
  boom(): never {
    // Fail closed: only the known non-prod envs expose the route. Anything else — production, or any
    // value not on the allowlist — is a 404, so the endpoint is absent from a real deployment even
    // if the NODE_ENV enum guard is ever loosened.
    const env = this.config.get<string>('app.env');
    if (env !== 'development' && env !== 'test') {
      throw new NotFoundException();
    }
    throw new Error('Intentional boom: verifying the error-tracking pipeline');
  }
}
