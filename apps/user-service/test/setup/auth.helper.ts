import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  CSRF_HEADER,
  CSRF_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from '../../src/modules/user/interface/security/auth-cookie.constants';

export interface Credentials {
  email: string;
  password: string;
}

/** `setCookies` is the raw Set-Cookie array, replayed on refresh and logout. */
export interface Session {
  accessToken: string;
  expiresIn: number;
  setCookies: string[];
  refreshToken: string;
  csrfToken: string;
}

export function authHeader(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

export function extractSetCookies(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as string[] | string | undefined;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

export function setCookieEntry(res: request.Response, name: string): string | undefined {
  return extractSetCookies(res).find((c) => c.startsWith(`${name}=`));
}

export function cookieValueOf(res: request.Response, name: string): string | undefined {
  return parseCookieValues(extractSetCookies(res))[name];
}

function parseCookieValues(setCookies: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const cookie of setCookies) {
    const [pair] = cookie.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) values[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return values;
}

/** Add `authHeader(...)` for logout, which also wants the bearer. */
export function sessionHeaders(session: Session): Record<string, string> {
  const cookie = session.setCookies.map((c) => c.split(';')[0].trim()).join('; ');
  return { Cookie: cookie, [CSRF_HEADER]: session.csrfToken };
}

/** Over HTTP, so the refresh token has a persisted family to rotate and reuse. */
export async function loginAs(app: INestApplication, credentials: Credentials): Promise<Session> {
  const res = await request(app.getHttpServer()).post('/auth/login').send(credentials).expect(200);
  return sessionFrom(res);
}

/** The session a login or refresh response hands out. */
export function sessionFrom(res: request.Response): Session {
  const setCookies = extractSetCookies(res);
  const values = parseCookieValues(setCookies);
  return {
    accessToken: res.body.accessToken as string,
    expiresIn: res.body.expiresIn as number,
    setCookies,
    refreshToken: values[REFRESH_TOKEN_COOKIE],
    csrfToken: values[CSRF_TOKEN_COOKIE],
  };
}
