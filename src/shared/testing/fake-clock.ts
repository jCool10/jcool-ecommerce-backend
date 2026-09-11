import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Pins wall-clock time for a whole describe, so a spec can assert on a cutoff the code computes from
 * `Date.now()` without racing it.
 *
 * Call it from the describe body, never from inside another hook: Vitest collects hooks while the
 * body is evaluated and silently drops one registered later. Restoring real timers afterwards is the
 * point of pairing them here — a file that leaks fake timers hangs the next file in the same worker.
 */
export function useFakeClock(now: Date): void {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
}
