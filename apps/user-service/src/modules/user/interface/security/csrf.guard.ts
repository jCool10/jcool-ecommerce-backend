import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { CSRF_HEADER, CSRF_TOKEN_COOKIE } from './auth-cookie.constants';
import { CsrfTokenService } from './csrf-token.service';

/** Runs after the global JwtAuthGuard, so an invalid access token 401s before this can 403. */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly csrf: CsrfTokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const cookieValue = request.cookies?.[CSRF_TOKEN_COOKIE] as string | undefined;
    const headerValue = request.header(CSRF_HEADER);

    if (!this.csrf.verify(cookieValue, headerValue)) {
      // `cause` is logged, never sent. Passing options drops Nest's default description, so it is restated.
      throw new ForbiddenException('Invalid or missing CSRF token', {
        cause: new Error(csrfFailure(cookieValue, headerValue)),
        description: 'Forbidden',
      });
    }
    return true;
  }
}

function csrfFailure(cookieValue: string | undefined, headerValue: string | undefined): string {
  if (!cookieValue) return 'csrf cookie missing';
  if (!headerValue) return 'csrf header missing';
  return cookieValue === headerValue ? 'csrf token signature invalid' : 'csrf header does not match the cookie';
}
