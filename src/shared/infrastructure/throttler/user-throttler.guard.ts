import { Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ThrottlerModuleOptions, ThrottlerRequest, ThrottlerStorage } from '@nestjs/throttler';
import { PinoLogger } from 'nestjs-pino';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { MeteredThrottlerGuard } from './metered-throttler.guard';
import { USER_THROTTLER } from './throttler.constants';

// Matched structurally rather than by importing the auth module's type: shared can't depend on a
// bounded context, and the id JwtAuthGuard attaches is all this needs.
interface MaybeAuthenticatedRequest {
  user?: { userId?: unknown };
}

/**
 * Route-level throttler for the `user` tier: caps one authenticated account however many IPs it
 * comes from — the limit an IP tier can't express. Mounted with `@UseGuards` rather than globally
 * because the global guard runs ahead of JwtAuthGuard, where `req.user` does not exist yet.
 */
@Injectable()
export class UserThrottlerGuard extends MeteredThrottlerGuard {
  constructor(
    options: ThrottlerModuleOptions,
    storageService: ThrottlerStorage,
    reflector: Reflector,
    @Inject(METRICS) metrics: MetricsPort,
    logger: PinoLogger,
  ) {
    super(options, storageService, reflector, metrics, logger);
  }

  // The IP tiers belong to the global guard; running them again here would charge each request twice.
  protected override handleRequest(request: ThrottlerRequest): Promise<boolean> {
    if (request.throttler.name !== USER_THROTTLER) {
      return Promise.resolve(true);
    }
    return super.handleRequest(request);
  }

  // The user id is not PII the way an email is, so it keys the bucket directly (no hash). Mounted
  // on a route that never authenticates, this falls back to the IP bucket rather than to no bucket.
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const { user } = req as MaybeAuthenticatedRequest;
    return typeof user?.userId === 'string' ? Promise.resolve(`user:${user.userId}`) : super.getTracker(req);
  }
}
