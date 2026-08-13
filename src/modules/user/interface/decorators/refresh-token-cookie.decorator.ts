import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { REFRESH_TOKEN_COOKIE } from '../security/auth-cookie.constants';

// Named function so it's unit-testable without Nest's decorator machinery.
// Returns undefined when the cookie is absent; the handler maps that to a 401.
export function refreshTokenCookieFactory(_data: unknown, ctx: ExecutionContext): string | undefined {
  const request = ctx.switchToHttp().getRequest<Request>();
  return request.cookies?.[REFRESH_TOKEN_COOKIE] as string | undefined;
}

/** Inject the raw refresh token read from the httpOnly cookie (Phase 2 delivery). */
export const RefreshTokenCookie = createParamDecorator(refreshTokenCookieFactory);
