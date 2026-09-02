import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogSampler } from './log-sampler';

const WINDOW_MS = 1_000;

describe('createLogSampler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes the first occurrence of a key and swallows the burst behind it', () => {
    const shouldLog = createLogSampler(WINDOW_MS);

    expect(shouldLog('user|/orders')).toBe(true);

    const burst: boolean[] = [];
    for (let i = 0; i < 500; i++) {
      burst.push(shouldLog('user|/orders'));
    }
    expect(burst).not.toContain(true);
  });

  it('keeps keys apart, so one noisy route cannot silence another', () => {
    const shouldLog = createLogSampler(WINDOW_MS);

    expect(shouldLog('user|/orders')).toBe(true);
    expect(shouldLog('default|/auth/login')).toBe(true);
  });

  it('passes again once the window has elapsed', () => {
    vi.useFakeTimers();
    const shouldLog = createLogSampler(WINDOW_MS);

    expect(shouldLog('user|/orders')).toBe(true);
    vi.advanceTimersByTime(WINDOW_MS - 1);
    expect(shouldLog('user|/orders')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(shouldLog('user|/orders')).toBe(true);
  });

  it('forgets rather than grows when a caller keys on something per-request', () => {
    const shouldLog = createLogSampler(WINDOW_MS);

    expect(shouldLog('user|/orders')).toBe(true);
    for (let i = 0; i < 1_000; i++) {
      shouldLog(`key-${i}`);
    }

    // Suppression was dropped along with the entries, still inside the window — the price of a
    // bound that costs nothing to maintain, and the reason keys come from a fixed set.
    expect(shouldLog('user|/orders')).toBe(true);
  });
});
