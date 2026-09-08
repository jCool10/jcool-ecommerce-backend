import { createHash } from 'node:crypto';
import { Inject, Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ThrottlerModuleOptions, ThrottlerRequest, ThrottlerStorage } from '@nestjs/throttler';
import type { Request } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { MeteredThrottlerGuard } from './metered-throttler.guard';
import { ACCOUNT_THROTTLER, USER_THROTTLER } from './throttler.constants';

/**
 * Keys the `account` tier by IP + hashed email, so brute-forcing one account can't lock out others
 * behind the same NAT. Other tiers stay IP-only, which is what catches password-spray.
 */
@Injectable()
export class AccountAwareThrottlerGuard extends MeteredThrottlerGuard {
  constructor(
    options: ThrottlerModuleOptions,
    storageService: ThrottlerStorage,
    reflector: Reflector,
    @Inject(METRICS) metrics: MetricsPort,
    logger: PinoLogger,
  ) {
    super(options, storageService, reflector, metrics, logger);
  }

  // This guard is global, so it runs before authentication and has no user to key the `user` tier
  // by; UserThrottlerGuard enforces that tier per route, after JwtAuthGuard has run.
  protected override handleRequest(request: ThrottlerRequest): Promise<boolean> {
    if (request.throttler.name === USER_THROTTLER) {
      return Promise.resolve(true);
    }
    return super.handleRequest(request);
  }

  protected generateKey(context: ExecutionContext, suffix: string, name: string): string {
    if (name === ACCOUNT_THROTTLER) {
      const request = context.switchToHttp().getRequest<Request>();
      return super.generateKey(context, this.accountSuffix(suffix, request.body), name);
    }
    return super.generateKey(context, suffix, name);
  }

  private accountSuffix(ipSuffix: string, body: unknown): string {
    const email = this.extractEmail(body);
    if (!email) {
      return ipSuffix;
    }
    const hashed = createHash('sha256').update(email).digest('hex').slice(0, 16);
    return `${ipSuffix}:${hashed}`;
  }

  // Body is parsed but not yet validated here; accept only a non-empty string email and
  // normalise it like login (trim + lowercase) so both key to the same bucket.
  private extractEmail(body: unknown): string | undefined {
    if (typeof body === 'object' && body !== null && 'email' in body) {
      const { email } = body;
      if (typeof email === 'string' && email.trim().length > 0) {
        return email.trim().toLowerCase();
      }
    }
    return undefined;
  }
}
