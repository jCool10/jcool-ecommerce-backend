import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { REFRESH_TOKEN_COOKIE } from '../security';

// Named function so it's unit-testable without Nest's decorator machinery.
export function refreshTokenCookieFactory(_data: unknown, ctx: ExecutionContext): string | undefined {
  const request = ctx.switchToHttp().getRequest<Request>();
  // cookie-parser can JSON-decode a `j:`-prefixed cookie into a non-string; treat that as absent.
  const value: unknown = request.cookies?.[REFRESH_TOKEN_COOKIE];
  return typeof value === 'string' ? value : undefined;
}

export const RefreshTokenCookie = createParamDecorator(refreshTokenCookieFactory);
