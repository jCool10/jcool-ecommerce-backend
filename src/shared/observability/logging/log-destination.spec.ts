import { describe, expect, it } from 'vitest';
import { flushLogsSync, getLogDestination } from './log-destination';

describe('log destination', () => {
  // The shutdown hook has to flush the very stream the logger writes into. Two instances would
  // flush one buffer and silently drop the other — a log-loss bug with no signal of its own.
  it('is a singleton', () => {
    expect(getLogDestination()).toBe(getLogDestination());
  });

  it('batches writes but stays async, so logging never blocks the event loop', () => {
    const destination = getLogDestination() as unknown as { sync: boolean; minLength: number };

    expect(destination.sync).toBe(false);
    expect(destination.minLength).toBeGreaterThan(0);
  });

  it('exposes the blocking flush the exit paths depend on', () => {
    expect(typeof getLogDestination().flushSync).toBe('function');
  });

  // Called on every way out of the process, including ones where the destination was never built
  // (dev/test) — a throw here would replace the real cause of death with a logging error.
  it('never throws', () => {
    expect(() => flushLogsSync()).not.toThrow();
  });
});
