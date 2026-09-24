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

  // The cause only reaches the log line, so the client cannot tell which check it failed.
  it('refuses every failed check with one generic 403, naming each in a distinct cause', () => {
    const failures: Array<[cookie: string | undefined, header: string | undefined]> = [
      [undefined, csrf.issue()],
      [csrf.issue(), undefined],
      [csrf.issue(), csrf.issue()],
      ['forged.signature', 'forged.signature'],
    ];

    const refusals = failures.map(([cookie, header]) => {
      try {
        guard.canActivate(contextWith(cookie, header));
        return undefined;
      } catch (error) {
        return error as ForbiddenException;
      }
    });

    expect(refusals.map((refusal) => refusal?.getResponse())).toEqual(
      failures.map(() => ({ message: 'Invalid or missing CSRF token', error: 'Forbidden', statusCode: 403 })),
    );
    expect(new Set(refusals.map((refusal) => (refusal?.cause as Error).message)).size).toBe(failures.length);
  });
});
