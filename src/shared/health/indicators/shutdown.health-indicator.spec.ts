import type { HealthIndicatorService } from '@nestjs/terminus';
import { describe, expect, it } from 'vitest';
import type { ShutdownService } from '../shutdown.service';
import { ShutdownHealthIndicator } from './shutdown.health-indicator';

// Fake the Terminus session: check(key) hands back up()/down() builders that stamp the key,
// so the test asserts the indicator's up/down decision without booting TerminusModule.
const healthIndicatorService = {
  check: (key: string) => ({
    up: () => ({ [key]: { status: 'up' } }),
    down: (data?: Record<string, unknown>) => ({ [key]: { status: 'down', ...data } }),
  }),
} as unknown as HealthIndicatorService;

const shutdownAt = (shuttingDown: boolean): ShutdownService =>
  ({ isShuttingDown: () => shuttingDown }) as unknown as ShutdownService;

describe('ShutdownHealthIndicator', () => {
  it('is up while the process is serving normally', () => {
    const indicator = new ShutdownHealthIndicator(healthIndicatorService, shutdownAt(false));
    expect(indicator.isHealthy('shutdown')).toEqual({ shutdown: { status: 'up' } });
  });

  it('is down once shutdown has begun (drives readiness 503)', () => {
    const indicator = new ShutdownHealthIndicator(healthIndicatorService, shutdownAt(true));
    expect(indicator.isHealthy('shutdown')).toEqual({ shutdown: { status: 'down', message: 'shutting down' } });
  });
});
