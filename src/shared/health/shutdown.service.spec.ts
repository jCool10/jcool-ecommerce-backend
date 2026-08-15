import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShutdownService } from './shutdown.service';

const configWithGrace = (ms: number | undefined): ConfigService => ({ get: () => ms }) as unknown as ConfigService;

describe('ShutdownService', () => {
  afterEach(() => vi.useRealTimers());

  it('is not shutting down until the shutdown hook fires', () => {
    const service = new ShutdownService(configWithGrace(0));
    expect(service.isShuttingDown()).toBe(false);
  });

  it('defaults the grace period to 0 when unconfigured (instant shutdown in tests/dev)', async () => {
    const service = new ShutdownService(configWithGrace(undefined));
    await expect(service.beforeApplicationShutdown('SIGTERM')).resolves.toBeUndefined();
    expect(service.isShuttingDown()).toBe(true);
  });

  it('flags shutdown when beforeApplicationShutdown runs', async () => {
    const service = new ShutdownService(configWithGrace(0));
    await service.beforeApplicationShutdown('SIGTERM');
    expect(service.isShuttingDown()).toBe(true);
  });

  it('holds for the configured grace before resolving; flag is set up front', async () => {
    vi.useFakeTimers();
    const service = new ShutdownService(configWithGrace(5000));

    const pending = service.beforeApplicationShutdown('SIGTERM');
    // Flag flips synchronously so /health/ready 503s for the WHOLE grace window, not just after it.
    expect(service.isShuttingDown()).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toBeUndefined();
  });
});
