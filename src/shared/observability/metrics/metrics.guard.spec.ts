import type { ExecutionContext } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { MetricsTokenGuard } from './metrics.guard';

// ConfigService fake keyed by the two config paths the guard reads.
function configFor(token: string | undefined, env: string): ConfigService {
  return {
    get: (key: string): unknown => (key === 'metrics.token' ? token : key === 'app.env' ? env : undefined),
  } as unknown as ConfigService;
}

function contextWithAuth(authorization?: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers: authorization ? { authorization } : {} }) }),
  } as unknown as ExecutionContext;
}

describe('MetricsTokenGuard', () => {
  const TOKEN = 'super-secret-metrics-token';

  it('allows a request carrying the correct bearer token', () => {
    const guard = new MetricsTokenGuard(configFor(TOKEN, 'production'));
    expect(guard.canActivate(contextWithAuth(`Bearer ${TOKEN}`))).toBe(true);
  });

  it('404s a wrong token (not 401 — never confirms the endpoint exists)', () => {
    const guard = new MetricsTokenGuard(configFor(TOKEN, 'production'));
    expect(() => guard.canActivate(contextWithAuth('Bearer nope'))).toThrow(NotFoundException);
  });

  it('404s a missing Authorization header', () => {
    const guard = new MetricsTokenGuard(configFor(TOKEN, 'production'));
    expect(() => guard.canActivate(contextWithAuth())).toThrow(NotFoundException);
  });

  it('allows scraping in dev when no token is configured (local convenience)', () => {
    const guard = new MetricsTokenGuard(configFor(undefined, 'development'));
    expect(guard.canActivate(contextWithAuth())).toBe(true);
  });

  it('hides the endpoint in production when no token is configured (misconfiguration)', () => {
    const guard = new MetricsTokenGuard(configFor(undefined, 'production'));
    expect(() => guard.canActivate(contextWithAuth())).toThrow(NotFoundException);
  });
});
