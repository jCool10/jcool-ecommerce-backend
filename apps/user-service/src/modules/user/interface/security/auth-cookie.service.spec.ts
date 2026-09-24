import type { CookieOptions, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { AUTH_COOKIE_PATH, CSRF_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from './auth-cookie.constants';
import { AuthCookieService } from './auth-cookie.service';
import { CsrfTokenService } from './csrf-token.service';

const config = fakeConfigService({
  'app.cookieSecure': true,
  'auth.refreshTokenTtl': '7d',
  'auth.csrfSecret': 'test-csrf-secret-not-a-real-secret-0000000',
});
const csrf = new CsrfTokenService(config);

function recordingResponse() {
  const set = new Map<string, { value: string; options: CookieOptions }>();
  const cleared: Array<{ name: string; options: CookieOptions }> = [];
  const res = {
    cookie: (name: string, value: string, options: CookieOptions) => set.set(name, { value, options }),
    clearCookie: (name: string, options: CookieOptions) => cleared.push({ name, options }),
  } as unknown as Response;
  return { res, set, cleared };
}

describe('AuthCookieService', () => {
  it('sets an httpOnly refresh cookie and a readable, valid CSRF cookie on /auth', () => {
    const { res, set } = recordingResponse();

    new AuthCookieService(config, csrf).setSession(res, 'the-refresh-token');

    const shared = { secure: true, sameSite: 'strict', path: AUTH_COOKIE_PATH, maxAge: 7 * 24 * 60 * 60 * 1000 };
    expect(set.get(REFRESH_TOKEN_COOKIE)).toEqual({
      value: 'the-refresh-token',
      options: { ...shared, httpOnly: true },
    });
    expect(set.get(CSRF_TOKEN_COOKIE)?.options).toEqual({ ...shared, httpOnly: false });
    const csrfToken = set.get(CSRF_TOKEN_COOKIE)?.value;
    expect(csrf.verify(csrfToken, csrfToken)).toBe(true);
  });

  // A browser keeps a cookie cleared under a different path.
  it('clears both cookies on the path they were set on', () => {
    const { res, cleared } = recordingResponse();

    new AuthCookieService(config, csrf).clear(res);

    expect(Object.fromEntries(cleared.map((c) => [c.name, c.options.path]))).toEqual({
      [REFRESH_TOKEN_COOKIE]: AUTH_COOKIE_PATH,
      [CSRF_TOKEN_COOKIE]: AUTH_COOKIE_PATH,
    });
  });
});
