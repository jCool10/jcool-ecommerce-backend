import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { AuthTokens } from '../../src/modules/user/application/services/auth-tokens.service';

export interface Credentials {
  email: string;
  password: string;
}

// Bearer header object for supertest `.set(...)`. Small helper so specs read as
// `.set(authHeader(token))` instead of hand-building the string each time.
export function authHeader(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

/**
 * Log in through the real `POST /auth/login` endpoint and return the token pair.
 * Deliberately goes over HTTP (not a minted token) so the refresh token has a
 * persisted family — the only way to exercise refresh rotation / reuse detection.
 */
export async function loginAs(app: INestApplication, credentials: Credentials): Promise<AuthTokens> {
  const res = await request(app.getHttpServer()).post('/auth/login').send(credentials).expect(200);
  return res.body as AuthTokens;
}
