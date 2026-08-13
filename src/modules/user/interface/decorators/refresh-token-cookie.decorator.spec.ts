import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { REFRESH_TOKEN_COOKIE } from '../security/auth-cookie.constants';
import { refreshTokenCookieFactory } from './refresh-token-cookie.decorator';

function contextWithCookies(cookies: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ cookies }) }),
  } as unknown as ExecutionContext;
}

describe('refreshTokenCookieFactory', () => {
  it('returns the refresh token from the cookie when present', () => {
    const ctx = contextWithCookies({ [REFRESH_TOKEN_COOKIE]: 'the-token' });
    expect(refreshTokenCookieFactory(undefined, ctx)).toBe('the-token');
  });

  it('returns undefined when the cookie is absent', () => {
    expect(refreshTokenCookieFactory(undefined, contextWithCookies({}))).toBeUndefined();
  });
});
