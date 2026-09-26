import type { ExecutionContext } from '@nestjs/common';
import { REFRESH_TOKEN_COOKIE } from '../security';
import { refreshTokenCookieFactory } from './refresh-token-cookie.decorator';

function contextWithCookies(cookies: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ cookies }) }),
  } as unknown as ExecutionContext;
}

describe('refreshTokenCookieFactory', () => {
  it('returns the cookie value when it is a string', () => {
    const value = refreshTokenCookieFactory(undefined, contextWithCookies({ [REFRESH_TOKEN_COOKIE]: 'raw-token' }));

    expect(value).toBe('raw-token');
  });

  it('treats a missing cookie as absent', () => {
    expect(refreshTokenCookieFactory(undefined, contextWithCookies({}))).toBeUndefined();
  });

  // cookie-parser JSON-decodes a `j:`-prefixed cookie, so a forged one arrives as an object here
  // instead of the string every caller casts it to.
  it('treats a non-string cookie value as absent instead of handing it on', () => {
    expect(refreshTokenCookieFactory(undefined, contextWithCookies({ [REFRESH_TOKEN_COOKIE]: {} }))).toBeUndefined();
    expect(refreshTokenCookieFactory(undefined, contextWithCookies({ [REFRESH_TOKEN_COOKIE]: 42 }))).toBeUndefined();
  });
});
