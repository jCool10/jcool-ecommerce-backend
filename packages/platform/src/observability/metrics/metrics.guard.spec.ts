import type { ExecutionContext } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { MetricsTokenGuard } from './metrics.guard';

function configFor(token: string | undefined, env: string): ConfigService {
  return fakeConfigService({ 'metrics.token': token, 'app.env': env });
}

function contextWithAuth(authorization?: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers: authorization ? { authorization } : {} }) }),
  } as unknown as ExecutionContext;
}

describe('MetricsTokenGuard', () => {
  it('allows scraping in dev when no token is configured', () => {
    const guard = new MetricsTokenGuard(configFor(undefined, 'development'));
    expect(guard.canActivate(contextWithAuth())).toBe(true);
  });

  it('hides the endpoint in production when no token is configured', () => {
    const guard = new MetricsTokenGuard(configFor(undefined, 'production'));
    expect(() => guard.canActivate(contextWithAuth())).toThrow(NotFoundException);
  });

  describe('with a token configured in production', () => {
    const TOKEN = 'scrape-token-0123456789';
    const guard = new MetricsTokenGuard(configFor(TOKEN, 'production'));

    it.each([`Bearer ${TOKEN}`, `bearer ${TOKEN}`])('lets %s scrape', (authorization) => {
      expect(guard.canActivate(contextWithAuth(authorization))).toBe(true);
    });

    // A length mismatch must answer 404 too: `timingSafeEqual` throws a RangeError on unequal lengths.
    it.each([
      ['a wrong token of the same length', `Bearer ${'x'.repeat(TOKEN.length)}`],
      ['no header', undefined],
      ['the Basic scheme', `Basic ${TOKEN}`],
      ['a shorter token', `Bearer ${TOKEN.slice(1)}`],
      ['a longer token', `Bearer ${TOKEN}x`],
    ])('hides the endpoint from %s', (_case, authorization) => {
      expect(() => guard.canActivate(contextWithAuth(authorization))).toThrow(NotFoundException);
    });
  });
});
