import type { Reflector } from '@nestjs/core';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { describe, expect, it } from 'vitest';
import { UserThrottlerGuard } from './user-throttler.guard';

function trackerFor(request: Record<string, unknown>): Promise<string> {
  const guard = new UserThrottlerGuard(
    { throttlers: [] },
    {} as ThrottlerStorage,
    {} as Reflector,
    fakeMetricsPort(),
    fakePinoLogger(),
  );
  // getTracker is protected.
  return (guard as unknown as { getTracker(req: Record<string, unknown>): Promise<string> }).getTracker(request);
}

describe('UserThrottlerGuard', () => {
  it('keys an authenticated caller by user id, whatever IP it comes from', async () => {
    const trackers = await Promise.all([
      trackerFor({ ip: '1.1.1.1', user: { userId: 'u-1' } }),
      trackerFor({ ip: '2.2.2.2', user: { userId: 'u-1' } }),
      trackerFor({ ip: '1.1.1.1', user: { userId: 'u-2' } }),
    ]);

    expect(trackers[0]).toBe(trackers[1]);
    expect(trackers[0]).not.toBe(trackers[2]);
  });

  it('falls back to the IP when no user is attached', async () => {
    await expect(trackerFor({ ip: '1.2.3.4' })).resolves.toBe('1.2.3.4');
  });
});
