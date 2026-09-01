import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { ThrottlerException, type ThrottlerRequest, type ThrottlerStorage } from '@nestjs/throttler';
import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import type { MetricsPort } from '@shared/observability/metrics/metrics.port';
import { MeteredThrottlerGuard } from './metered-throttler.guard';
import { DEFAULT_THROTTLER, USER_THROTTLER } from './throttler.constants';

class OrderController {}
function create() {}

// Only the framework boundary is faked: the storage decides whether the tier is over its limit,
// and the reflector carries the route metadata resolveRouteTemplate reads.
const context = {
  switchToHttp: () => ({
    getRequest: () => ({ ip: '1.2.3.4', path: '/orders' }),
    getResponse: () => ({ header: vi.fn() }),
  }),
  getClass: () => OrderController,
  getHandler: () => create,
} as unknown as ExecutionContext;

const reflector = {
  get: (_key: unknown, target: unknown) => (target === OrderController ? 'orders' : undefined),
} as unknown as Reflector;

function incrementReturning(isBlocked: boolean) {
  return vi.fn<ThrottlerStorage['increment']>().mockResolvedValue({
    totalHits: 11,
    timeToExpire: 30,
    isBlocked,
    timeToBlockExpire: isBlocked ? 30 : 0,
  });
}

function fakeLogger() {
  return { warn: vi.fn() };
}

async function build(isBlocked: boolean) {
  const increment = incrementReturning(isBlocked);
  const recordRateLimitRejection = vi.fn();
  const logger = fakeLogger();
  const guard = new MeteredThrottlerGuard(
    { throttlers: [] },
    { increment },
    reflector,
    { recordRateLimitRejection } as unknown as MetricsPort,
    logger as unknown as PinoLogger,
  );
  await guard.onModuleInit(); // resolves the options the base guard reads per request
  const shim = guard as unknown as { handleRequest(request: ThrottlerRequest): Promise<boolean> };
  return { shim, increment, recordRateLimitRejection, logger };
}

const request: ThrottlerRequest = {
  context,
  limit: 10,
  ttl: 60_000,
  blockDuration: 60_000,
  throttler: { name: USER_THROTTLER, limit: 10, ttl: 60_000 },
  getTracker: () => Promise.resolve('user:abc'),
  generateKey: () => 'key',
};

describe('MeteredThrottlerGuard', () => {
  it('counts a rejection against the tier that ran out and the route template', async () => {
    const { shim, recordRateLimitRejection } = await build(true);

    await expect(shim.handleRequest(request)).rejects.toBeInstanceOf(ThrottlerException);

    expect(recordRateLimitRejection).toHaveBeenCalledWith(USER_THROTTLER, '/orders');
  });

  // The tier is the field the exception filter's own 429 line cannot carry, and the only one that
  // separates a spray from one client retrying too fast.
  it('names the tier in the rejection log', async () => {
    const { shim, logger } = await build(true);

    await expect(shim.handleRequest(request)).rejects.toBeInstanceOf(ThrottlerException);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tier: USER_THROTTLER, route: '/orders' }),
      expect.any(String),
    );
  });

  it('counts nothing while the caller is under the limit', async () => {
    const { shim, recordRateLimitRejection, logger } = await build(false);

    await expect(shim.handleRequest(request)).resolves.toBe(true);

    expect(recordRateLimitRejection).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stops enforcing entirely while the kill-switch is off', async () => {
    const increment = incrementReturning(true);
    const guard = new MeteredThrottlerGuard(
      { throttlers: [{ name: DEFAULT_THROTTLER, limit: 1, ttl: 60_000 }] },
      { increment },
      reflector,
      { recordRateLimitRejection: vi.fn() } as unknown as MetricsPort,
      fakeLogger() as unknown as PinoLogger,
    );
    await guard.onModuleInit();
    const previous = process.env.THROTTLE_ENABLED;
    process.env.THROTTLE_ENABLED = 'false';

    try {
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(increment).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.THROTTLE_ENABLED;
      else process.env.THROTTLE_ENABLED = previous;
    }
  });
});
