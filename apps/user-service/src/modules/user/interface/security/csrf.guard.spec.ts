import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { CSRF_HEADER, CSRF_TOKEN_COOKIE } from './auth-cookie.constants';
import { CsrfGuard } from './csrf.guard';
import { CsrfTokenService } from './csrf-token.service';

const csrf = new CsrfTokenService(
  fakeConfigService({ 'auth.csrfSecret': 'test-jwt-access-secret-not-a-real-secret-000' }),
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

  it.each([
    ['the cookie is missing', () => [undefined, csrf.issue()], 'csrf cookie missing'],
    ['the header is missing', () => [csrf.issue(), undefined], 'csrf header missing'],
    ['the header echoes another token', () => [csrf.issue(), csrf.issue()], 'csrf header does not match the cookie'],
    ['the token is unsigned', () => ['forged.signature', 'forged.signature'], 'csrf token signature invalid'],
  ])('names the failed check as the cause when %s, keeping the client message generic', (_case, values, reason) => {
    const [cookieValue, headerValue] = values();
    let refusal: unknown;
    try {
      guard.canActivate(contextWith(cookieValue, headerValue));
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(ForbiddenException);
    expect((refusal as ForbiddenException).getResponse()).toEqual({
      message: 'Invalid or missing CSRF token',
      error: 'Forbidden',
      statusCode: 403,
    });
    expect((refusal as { cause?: Error }).cause?.message).toBe(reason);
  });
});
