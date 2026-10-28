import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { CALLER_TOKENS_CONFIG_KEY, type CallerTokens } from './caller-tokens.config';
import { INTERNAL_CALLERS_KEY } from './internal-callers.decorator';

const BEARER = /^bearer\s+(\S+)$/i;

// Digests, so the comparison is fixed-length and a token's length leaks nothing either.
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

export interface InternalCallerRequest {
  headers: { authorization?: string };
  /** Set once the bearer identified a caller the route allows. */
  internalCaller?: string;
}

/** Service-to-service auth: the bearer names the caller, the route's `@InternalCallers` decides. */
@Injectable()
export class CallerTokenGuard implements CanActivate {
  private readonly accepted: { caller: string; digest: Buffer }[];

  constructor(
    config: ConfigService,
    private readonly reflector: Reflector,
  ) {
    const callers = config.getOrThrow<CallerTokens>(CALLER_TOKENS_CONFIG_KEY);
    this.accepted = Object.entries(callers).flatMap(([caller, tokens]) =>
      tokens.map((token) => ({ caller, digest: digest(token) })),
    );
    if (this.accepted.length === 0) throw new Error('no internal caller token is set');

    for (const [index, one] of this.accepted.entries()) {
      const twin = this.accepted.slice(index + 1).find((other) => other.digest.equals(one.digest));
      if (twin && twin.caller !== one.caller) {
        throw new Error(`internal callers ${one.caller} and ${twin.caller} share a token`);
      }
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<InternalCallerRequest>();
    const presented = request.headers.authorization?.match(BEARER)?.[1];
    const caller = presented === undefined ? undefined : this.identify(digest(presented));
    if (caller === undefined) {
      // `cause` is logged, never sent. Passing options drops Nest's default description, so it is restated.
      throw new UnauthorizedException(undefined, {
        cause: new Error(presented ? 'internal caller token not recognized' : 'missing internal caller bearer token'),
        description: 'Unauthorized',
      });
    }

    const allowed = this.reflector.getAllAndOverride<string[] | undefined>(INTERNAL_CALLERS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowed?.includes(caller)) {
      throw new ForbiddenException(undefined, {
        cause: new Error(`internal caller ${caller} is not allowed on this route`),
        description: 'Forbidden',
      });
    }
    request.internalCaller = caller;
    return true;
  }

  // Every digest is compared, so which one matched does not show in the timing.
  private identify(candidate: Buffer): string | undefined {
    let caller: string | undefined;
    for (const token of this.accepted) {
      if (timingSafeEqual(token.digest, candidate)) caller = token.caller;
    }
    return caller;
  }
}
