import type { HealthIndicatorService } from '@nestjs/terminus';
import { describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { DrizzleDBOf, DrizzleSchema } from '../../database';
import { DrizzleHealthIndicator } from './drizzle.health-indicator';

// Fake Terminus session, so the up/down decision is asserted without booting TerminusModule.
const healthIndicatorService = {
  check: (key: string) => ({
    up: () => ({ [key]: { status: 'up' } }),
    down: (data?: Record<string, unknown>) => ({ [key]: { status: 'down', ...data } }),
  }),
} as unknown as HealthIndicatorService;

function build(execute: () => Promise<unknown>) {
  const error = vi.fn();
  const info = vi.fn();
  const db = { execute } as unknown as DrizzleDBOf<DrizzleSchema>;
  const indicator = new DrizzleHealthIndicator(healthIndicatorService, db, fakePinoLogger({ error, info }));
  return { indicator, error, info };
}

describe('DrizzleHealthIndicator', () => {
  it('is up on a successful SELECT 1, and logs nothing the first time', async () => {
    const { indicator, error, info } = build(() => Promise.resolve());

    await expect(indicator.isHealthy('database')).resolves.toEqual({ database: { status: 'up' } });

    expect(error).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('logs once when readiness first fails, not again while it stays down', async () => {
    const boom = new Error('connection refused');
    const { indicator, error } = build(() => Promise.reject(boom));

    await indicator.isHealthy('database');
    await indicator.isHealthy('database');

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'connection refused' }) as unknown },
      'database readiness check failed',
    );
  });

  it('logs a recovery once readiness comes back, not on every subsequent success', async () => {
    let up = false;
    const { indicator, info, error } = build(() => (up ? Promise.resolve() : Promise.reject(new Error('down'))));

    await indicator.isHealthy('database');
    up = true;
    await indicator.isHealthy('database');
    await indicator.isHealthy('database');

    expect(error).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('database readiness recovered');
  });
});
