import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@shared/testing/fake-config.service';
import { fakePinoLogger } from '@shared/testing/fake-pino-logger';
import { ShutdownService } from './shutdown.service';

const serviceWithGrace = (ms: number | undefined): ShutdownService =>
  new ShutdownService(fakeConfigService({ 'app.shutdownGracePeriodMs': ms }), fakePinoLogger());

describe('ShutdownService', () => {
  afterEach(() => vi.useRealTimers());

  it('is not shutting down until the shutdown hook fires', () => {
    const service = serviceWithGrace(0);
    expect(service.isShuttingDown()).toBe(false);
  });

  it('defaults the grace period to 0 when unconfigured (instant shutdown in tests/dev)', async () => {
    const service = serviceWithGrace(undefined);
    await expect(service.beforeApplicationShutdown('SIGTERM')).resolves.toBeUndefined();
    expect(service.isShuttingDown()).toBe(true);
  });

  it('flags shutdown when beforeApplicationShutdown runs', async () => {
    const service = serviceWithGrace(0);
    await service.beforeApplicationShutdown('SIGTERM');
    expect(service.isShuttingDown()).toBe(true);
  });

  it('holds for the configured grace before resolving; flag is set up front', async () => {
    vi.useFakeTimers();
    const service = serviceWithGrace(5000);

    const pending = service.beforeApplicationShutdown('SIGTERM');
    // Flag flips synchronously so /health/ready 503s for the WHOLE grace window, not just after it.
    expect(service.isShuttingDown()).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toBeUndefined();
  });
});
