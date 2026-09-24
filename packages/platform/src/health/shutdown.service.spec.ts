import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { ShutdownService } from './shutdown.service';

describe('ShutdownService', () => {
  afterEach(() => vi.useRealTimers());

  // Readiness must answer 503 for the whole grace window, so the flag cannot wait for the timer.
  it('flags shutdown at once and holds for the configured grace', async () => {
    vi.useFakeTimers();
    const service = new ShutdownService(fakeConfigService({ 'app.shutdownGracePeriodMs': 5000 }), fakePinoLogger());
    let settled = false;

    const pending = service.beforeApplicationShutdown('SIGTERM').then(() => {
      settled = true;
    });

    expect(service.isShuttingDown()).toBe(true);
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });
});
