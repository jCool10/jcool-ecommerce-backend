import type { HealthIndicatorService } from '@nestjs/terminus';
import { describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { RedisService } from '../../redis';
import { RedisHealthIndicator } from './redis.health-indicator';

// Fake Terminus session, so the up/down decision is asserted without booting TerminusModule.
const healthIndicatorService = {
  check: (key: string) => ({
    up: () => ({ [key]: { status: 'up' } }),
    down: (data?: Record<string, unknown>) => ({ [key]: { status: 'down', ...data } }),
  }),
} as unknown as HealthIndicatorService;

function build(ping: () => Promise<string>) {
  const error = vi.fn();
  const info = vi.fn();
  const redis = { ping } as unknown as RedisService;
  const indicator = new RedisHealthIndicator(healthIndicatorService, redis, fakePinoLogger({ error, info }));
  return { indicator, error, info };
}

describe('RedisHealthIndicator', () => {
  it('is up on PONG, and logs nothing the first time', async () => {
    const { indicator, error, info } = build(() => Promise.resolve('PONG'));

    await expect(indicator.isHealthy('redis')).resolves.toEqual({ redis: { status: 'up' } });

    expect(error).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('logs once when the ping throws, not again while it stays down', async () => {
    const boom = new Error('connection refused');
    const { indicator, error } = build(() => Promise.reject(boom));

    await indicator.isHealthy('redis');
    await indicator.isHealthy('redis');

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'connection refused' }) as unknown },
      'redis readiness check failed',
    );
  });

  it('logs once on an unexpected ping reply, not again while it repeats', async () => {
    const { indicator, error } = build(() => Promise.resolve('WRONG'));

    await indicator.isHealthy('redis');
    await indicator.isHealthy('redis');

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith({ reply: 'WRONG' }, 'redis readiness check got an unexpected ping reply');
  });

  it('logs a recovery once readiness comes back, not on every subsequent success', async () => {
    let up = false;
    const { indicator, info, error } = build(() => Promise.resolve(up ? 'PONG' : 'WRONG'));

    await indicator.isHealthy('redis');
    up = true;
    await indicator.isHealthy('redis');
    await indicator.isHealthy('redis');

    expect(error).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('redis readiness recovered');
  });
});
