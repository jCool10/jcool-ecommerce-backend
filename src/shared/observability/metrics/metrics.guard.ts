import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Guards `/metrics` with a bearer token (ADR-0018, option A). A missing/invalid token throws
 * 404 — not 401 — so an unauthenticated probe can't even confirm the endpoint exists (it
 * shares the public API port, so a 401 would leak the route map + error ratios for recon).
 * Comparison is constant-time. When no token is configured: allowed outside production (local
 * scraping convenience), hidden in production (a missing token there is a misconfiguration).
 */
@Injectable()
export class MetricsTokenGuard implements CanActivate {
  private readonly token: string | undefined;
  private readonly isProduction: boolean;

  constructor(config: ConfigService) {
    this.token = config.get<string>('metrics.token');
    this.isProduction = config.get<string>('app.env') === 'production';
  }

  canActivate(context: ExecutionContext): boolean {
    if (this.token === undefined || this.token === '') {
      if (this.isProduction) {
        throw new NotFoundException();
      }
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided = extractBearer(request.headers.authorization);
    if (provided === undefined || !safeEqual(provided, this.token)) {
      throw new NotFoundException();
    }
    return true;
  }
}

function extractBearer(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : undefined;
}

// Constant-time compare. Length is checked first (timingSafeEqual requires equal lengths);
// a length difference is an immediate mismatch — acceptable, and the standard pattern.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
