import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Every rejection is 404, never 401, so a probe cannot confirm the endpoint exists — including the
 * unconfigured-token case, which is allowed outside production and hidden in production.
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

// Constant-time compare; length checked first (timingSafeEqual requires equal lengths).
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
