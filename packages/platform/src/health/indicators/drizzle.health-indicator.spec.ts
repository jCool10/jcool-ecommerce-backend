import { HealthIndicatorService } from '@nestjs/terminus';
import { describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { DrizzleDBOf, DrizzleSchema } from '../../database';
import { DrizzleHealthIndicator } from './drizzle.health-indicator';

describe('DrizzleHealthIndicator', () => {
  // Readiness is polled every few seconds, so a line per probe would bury the outage it reports.
  it('reports each probe but logs only the transitions', async () => {
    const outcomes = [false, false, true, true];
    const execute = vi.fn(() => (outcomes.shift() ? Promise.resolve() : Promise.reject(new Error('refused'))));
    const error = vi.fn();
    const info = vi.fn();
    const indicator = new DrizzleHealthIndicator(
      new HealthIndicatorService(),
      { execute } as unknown as DrizzleDBOf<DrizzleSchema>,
      fakePinoLogger({ error, info }),
    );

    const statuses: string[] = [];
    for (let probe = 0; probe < 4; probe++) statuses.push((await indicator.isHealthy('database')).database.status);

    expect(statuses).toEqual(['down', 'down', 'up', 'up']);
    expect(error).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
  });
});
