import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { fakeConfigService } from '@shared/testing/fake-config.service';
import { CSRF_HEADER, CSRF_TOKEN_COOKIE } from './auth-cookie.constants';
import { CsrfGuard } from './csrf.guard';
import { CsrfTokenService } from './csrf-token.service';

const csrf = new CsrfTokenService(
  fakeConfigService({ 'auth.jwtAccessSecret': 'test-jwt-access-secret-not-a-real-secret-000' }),
);

function contextWith(cookieValue?: string, headerValue?: string): ExecutionContext {
  const request = {
    cookies: cookieValue === undefined ? {} : { [CSRF_TOKEN_COOKIE]: cookieValue },
    header: (name: string) => (name.toLowerCase() === CSRF_HEADER ? headerValue : undefined),
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('CsrfGuard', () => {
  const guard = new CsrfGuard(csrf);

  it('allows a request whose CSRF cookie and header match a valid token', () => {
    const token = csrf.issue();
    expect(guard.canActivate(contextWith(token, token))).toBe(true);
  });

  it('rejects when the CSRF cookie is missing', () => {
    const token = csrf.issue();
    expect(() => guard.canActivate(contextWith(undefined, token))).toThrow(ForbiddenException);
  });
});
