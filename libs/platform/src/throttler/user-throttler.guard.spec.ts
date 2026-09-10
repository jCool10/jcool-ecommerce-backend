import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { ThrottlerRequest, ThrottlerStorage } from '@nestjs/throttler';
import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import type { MetricsPort } from '@shared/observability/metrics/metrics.port';
import { DEFAULT_THROTTLER, USER_THROTTLER } from './throttler.constants';
import { UserThrottlerGuard } from './user-throttler.guard';

class OrderController {}
function create() {}

const context = {
  switchToHttp: () => ({
    getRequest: () => ({ ip: '1.2.3.4', path: '/orders' }),
    getResponse: () => ({ header: vi.fn() }),
  }),
  getClass: () => OrderController,
  getHandler: () => create,
} as unknown as ExecutionContext;

async function build() {
  const increment = vi.fn<ThrottlerStorage['increment']>().mockResolvedValue({
    totalHits: 1,
    timeToExpire: 60,
    isBlocked: false,
    timeToBlockExpire: 0,
  });
  const guard = new UserThrottlerGuard(
    { throttlers: [] },
    { increment },
    { get: () => undefined } as unknown as Reflector,
    {
      recordRateLimitRejection: vi.fn(),
    } as unknown as MetricsPort,
    { warn: vi.fn() } as unknown as PinoLogger,
  );
  await guard.onModuleInit(); // resolves the options the base guard reads per request
  const shim = guard as unknown as {
    getTracker(req: Record<string, unknown>): Promise<string>;
    handleRequest(request: ThrottlerRequest): Promise<boolean>;
  };
  return { shim, increment };
}

function requestFor(tier: string): ThrottlerRequest {
  return {
    context,
    limit: 10,
    ttl: 60_000,
    blockDuration: 60_000,
    throttler: { name: tier, limit: 10, ttl: 60_000 },
    getTracker: () => Promise.resolve('tracker'),
    generateKey: () => 'key',
  };
}

describe('UserThrottlerGuard', () => {
  it('keys an authenticated caller by user id, so one account is one bucket across IPs', async () => {
    const { shim } = await build();

    const first = await shim.getTracker({ ip: '1.1.1.1', user: { userId: 'u-1' } });
    const second = await shim.getTracker({ ip: '2.2.2.2', user: { userId: 'u-1' } });
    const other = await shim.getTracker({ ip: '1.1.1.1', user: { userId: 'u-2' } });

    expect(first).toBe(second);
    expect(first).not.toBe(other);
  });

  it('falls back to the IP when no user is attached, rather than to no bucket at all', async () => {
    const { shim } = await build();

    await expect(shim.getTracker({ ip: '1.2.3.4' })).resolves.toBe('1.2.3.4');
  });

  it('enforces only the user tier — the IP tiers belong to the global guard', async () => {
    const { shim, increment } = await build();

    await expect(shim.handleRequest(requestFor(DEFAULT_THROTTLER))).resolves.toBe(true);
    expect(increment).not.toHaveBeenCalled();

    await expect(shim.handleRequest(requestFor(USER_THROTTLER))).resolves.toBe(true);
    expect(increment).toHaveBeenCalledTimes(1);
  });
});
