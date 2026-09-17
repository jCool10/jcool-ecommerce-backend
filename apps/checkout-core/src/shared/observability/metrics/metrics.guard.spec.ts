import type { ExecutionContext } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { fakeConfigService } from '@shared/testing/fake-config.service';
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
  it('allows scraping in dev when no token is configured (local convenience)', () => {
    const guard = new MetricsTokenGuard(configFor(undefined, 'development'));
    expect(guard.canActivate(contextWithAuth())).toBe(true);
  });

  it('hides the endpoint in production when no token is configured (misconfiguration)', () => {
    const guard = new MetricsTokenGuard(configFor(undefined, 'production'));
    expect(() => guard.canActivate(contextWithAuth())).toThrow(NotFoundException);
  });
});
