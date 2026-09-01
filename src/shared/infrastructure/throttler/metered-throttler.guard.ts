import { Inject, Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerException,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request } from 'express';
import { resolveRouteTemplate } from '@shared/observability/http-route.util';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { DEFAULT_THROTTLER } from './throttler.constants';

/**
 * Base for this app's throttler guards: the enforcement kill-switch and the rejection counter,
 * so both live in one place. Subclasses decide only what a request is keyed by.
 */
@Injectable()
export class MeteredThrottlerGuard extends ThrottlerGuard {
  constructor(
    options: ThrottlerModuleOptions,
    storageService: ThrottlerStorage,
    reflector: Reflector,
    @Inject(METRICS) protected readonly metrics: MetricsPort,
  ) {
    super(options, storageService, reflector);
  }

  // Global kill-switch (load tests / e2e). Read per request rather than resolved once into the
  // module's `skipIf`, so a test can flip it around a single call without rebuilding the app.
  override canActivate(context: ExecutionContext): Promise<boolean> {
    if (process.env.THROTTLE_ENABLED === 'false') {
      return Promise.resolve(true);
    }
    return super.canActivate(context);
  }

  // Counted around the per-tier call rather than in throwThrottlingException, which isn't told
  // which tier ran out. The tier is what makes a 429 spike readable: on the pre-auth tiers it
  // reads as an attack or one NAT'd office, on the per-user tier as a single account misbehaving.
  protected override async handleRequest(request: ThrottlerRequest): Promise<boolean> {
    try {
      return await super.handleRequest(request);
    } catch (error) {
      if (error instanceof ThrottlerException) {
        this.recordRejection(request);
      }
      throw error;
    }
  }

  private recordRejection(request: ThrottlerRequest): void {
    const { context } = request;
    const path = context.switchToHttp().getRequest<Request>().path;
    this.metrics.recordRateLimitRejection(
      request.throttler.name ?? DEFAULT_THROTTLER,
      resolveRouteTemplate(this.reflector, context, path),
    );
  }
}
