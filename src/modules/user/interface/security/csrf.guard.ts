import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { CSRF_HEADER, CSRF_TOKEN_COOKIE } from './auth-cookie.constants';
import { CsrfTokenService } from './csrf-token.service';

/**
 * Enforces the signed double-submit CSRF check on the cookie-authenticated routes (refresh/logout);
 * runs after the global JwtAuthGuard, so an invalid access token 401s before this 403s.
 * See docs/engineering-notes.md (Auth — Token delivery (cookie) & CSRF).
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly csrf: CsrfTokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const cookieValue = request.cookies?.[CSRF_TOKEN_COOKIE] as string | undefined;
    const headerValue = request.header(CSRF_HEADER);

    if (!this.csrf.verify(cookieValue, headerValue)) {
      throw new ForbiddenException('Invalid or missing CSRF token');
    }
    return true;
  }
}
