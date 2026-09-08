import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { REFRESH_TOKEN_COOKIE } from '../security';

// Named function so it's unit-testable without Nest's decorator machinery.
export function refreshTokenCookieFactory(_data: unknown, ctx: ExecutionContext): string | undefined {
  const request = ctx.switchToHttp().getRequest<Request>();
  return request.cookies?.[REFRESH_TOKEN_COOKIE] as string | undefined;
}

export const RefreshTokenCookie = createParamDecorator(refreshTokenCookieFactory);
