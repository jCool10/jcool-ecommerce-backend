import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';
import { durationToMs } from '../../application';
import { AUTH_COOKIE_PATH, CSRF_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from './auth-cookie.constants';
import { CsrfTokenService } from './csrf-token.service';

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

  setSession(res: Response, refreshToken: string): void {
    res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, this.cookieOptions(true));
    res.cookie(CSRF_TOKEN_COOKIE, this.csrf.issue(), this.cookieOptions(false));
  }

  /** The attributes must match the ones they were set with, or the browser keeps the cookies. */
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
