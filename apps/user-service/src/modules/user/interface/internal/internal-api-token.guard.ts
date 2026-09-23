import { createHash, timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

const BEARER = /^bearer\s+(\S+)$/i;

// Digests, so the comparison is fixed-length and a token's length leaks nothing either.
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Accepts `INTERNAL_API_TOKEN`, and `INTERNAL_API_TOKEN_PREVIOUS` while callers roll over to it. */
@Injectable()
export class InternalApiTokenGuard implements CanActivate {
  private readonly accepted: Buffer[];

  constructor(config: ConfigService) {
    this.accepted = config.getOrThrow<string[]>('internalApi.tokens').map(digest);
    if (this.accepted.length === 0) throw new Error('INTERNAL_API_TOKEN is not set');
  }

  canActivate(context: ExecutionContext): boolean {
    const header = context.switchToHttp().getRequest<Request>().headers.authorization;
    const presented = header?.match(BEARER)?.[1];
    if (presented) {
      const candidate = digest(presented);
      // Every token is compared, so which one matched does not show in the timing.
      const matches = this.accepted.filter((token) => timingSafeEqual(token, candidate));
      if (matches.length > 0) return true;
    }
    // `cause` is logged, never sent. Passing options drops Nest's default description, so it is restated.
    throw new UnauthorizedException(undefined, {
      cause: new Error(presented ? 'internal api token not recognized' : 'missing internal api bearer token'),
      description: 'Unauthorized',
    });
  }
}
