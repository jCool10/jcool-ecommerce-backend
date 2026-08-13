import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';
import { durationToMs } from '../../application/duration-to-ms';
import { AUTH_COOKIE_PATH, CSRF_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from './auth-cookie.constants';
import { CsrfTokenService } from './csrf-token.service';

/**
 * Owns the auth-cookie contract in one place: sets the httpOnly refresh cookie + paired readable
 * CSRF cookie on login/refresh, clears both on logout (httpOnly/Secure/SameSite=Strict/Path=/auth).
 * See docs/engineering-notes.md (Auth — Token delivery (cookie) & CSRF).
 */
@Injectable()
export class AuthCookieService {
  private readonly secure: boolean;
  private readonly maxAgeMs: number;

  constructor(
    config: ConfigService,
    private readonly csrf: CsrfTokenService,
  ) {
    this.secure = config.get<boolean>('app.cookieSecure') === true;
    this.maxAgeMs = durationToMs(config.getOrThrow<string>('auth.refreshTokenTtl'));
  }

  /** Set the refresh cookie (httpOnly) + a fresh readable CSRF cookie (echoed in x-csrf-token). */
  setSession(res: Response, refreshToken: string): void {
    res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, this.cookieOptions(true));
    res.cookie(CSRF_TOKEN_COOKIE, this.csrf.issue(), this.cookieOptions(false));
  }

  /** Clear both cookies on logout (same attributes so browsers actually drop them). */
  clear(res: Response): void {
    const options = { path: AUTH_COOKIE_PATH, sameSite: 'strict' as const, secure: this.secure };
    res.clearCookie(REFRESH_TOKEN_COOKIE, { ...options, httpOnly: true });
    res.clearCookie(CSRF_TOKEN_COOKIE, { ...options, httpOnly: false });
  }

  private cookieOptions(httpOnly: boolean): CookieOptions {
    return {
      httpOnly,
      secure: this.secure,
      sameSite: 'strict',
      path: AUTH_COOKIE_PATH,
      maxAge: this.maxAgeMs,
    };
  }
}
