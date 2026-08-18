import { BadRequestException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { Request } from 'express';

/** Request carrying the validated Idempotency-Key the guard normalized onto it. */
export interface IdempotentRequest extends Request {
  idempotencyKey?: string;
}

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * Fails fast (400) when a retry-safe endpoint is called without a valid `Idempotency-Key`.
 * Requiring the header is the endpoint's contract: the client must be able to name each attempt
 * so a network retry replays instead of double-charging. Runs after the global auth guards, so
 * an unauthenticated request still 401s before it reaches here. The normalized value is stashed
 * on the request for the interceptor, which owns the store lifecycle.
 */
@Injectable()
export class RequireIdempotencyKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<IdempotentRequest>();
    const raw = request.headers[IDEMPOTENCY_KEY_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;

    if (!value || !isUUID(value)) {
      throw new BadRequestException('A valid Idempotency-Key header (UUID) is required');
    }

    request.idempotencyKey = value;
    return true;
  }
}
