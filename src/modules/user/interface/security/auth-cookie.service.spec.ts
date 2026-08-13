import type { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { AUTH_COOKIE_PATH, CSRF_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from './auth-cookie.constants';
import { AuthCookieService } from './auth-cookie.service';
import type { CsrfTokenService } from './csrf-token.service';

interface CookieCall {
  name: string;
  value: string;
  options: CookieOptions;
}

// Config answering only the two keys the service reads.
function config(cookieSecure: boolean, refreshTtl = '7d'): ConfigService {
  return {
    get: (key: string) => (key === 'app.cookieSecure' ? cookieSecure : undefined),
    getOrThrow: (key: string) => {
      if (key === 'auth.refreshTokenTtl') return refreshTtl;
      throw new Error(`unexpected key ${key}`);
    },
  } as unknown as ConfigService;
}

const csrf = { issue: () => 'issued-csrf-token' } as unknown as CsrfTokenService;

// Response stub that records cookie()/clearCookie() calls.
function responseSpy() {
  const set: CookieCall[] = [];
  const cleared: Array<{ name: string; options: CookieOptions }> = [];
  const res = {
    cookie: (name: string, value: string, options: CookieOptions) => set.push({ name, value, options }),
    clearCookie: (name: string, options: CookieOptions) => cleared.push({ name, options }),
  } as unknown as Response;
  return { res, set, cleared };
}

describe('AuthCookieService', () => {
  it('sets the refresh cookie httpOnly + SameSite=Strict, scoped to /auth, with the refresh TTL', () => {
    const { res, set } = responseSpy();
    new AuthCookieService(config(true), csrf).setSession(res, 'the-refresh-token');

    const refresh = set.find((c) => c.name === REFRESH_TOKEN_COOKIE);
    expect(refresh?.value).toBe('the-refresh-token');
    expect(refresh?.options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: AUTH_COOKIE_PATH,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  });

  it('sets the CSRF cookie readable (not httpOnly) so the client can echo it', () => {
    const { res, set } = responseSpy();
    new AuthCookieService(config(true), csrf).setSession(res, 'r');

    const csrfCookie = set.find((c) => c.name === CSRF_TOKEN_COOKIE);
    expect(csrfCookie?.value).toBe('issued-csrf-token');
    expect(csrfCookie?.options.httpOnly).toBe(false);
    expect(csrfCookie?.options.sameSite).toBe('strict');
  });

  it('leaves cookies non-Secure when configured off (http dev/e2e)', () => {
    const { res, set } = responseSpy();
    new AuthCookieService(config(false), csrf).setSession(res, 'r');

    expect(set.every((c) => c.options.secure === false)).toBe(true);
  });

  it('clears both cookies on the same /auth path', () => {
    const { res, cleared } = responseSpy();
    new AuthCookieService(config(true), csrf).clear(res);

    expect(cleared.map((c) => c.name).sort()).toEqual([CSRF_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE]);
    expect(cleared.every((c) => c.options.path === AUTH_COOKIE_PATH)).toBe(true);
  });
});
