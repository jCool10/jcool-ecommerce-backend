import type { PinoLogger } from 'nestjs-pino';
import { vi, type Mock } from 'vitest';

/** A real `PinoLogger` to the code under test, a set of spies to the spec asserting on it. */
export type FakePinoLogger = PinoLogger & {
  trace: Mock;
  debug: Mock;
  info: Mock;
  warn: Mock;
  error: Mock;
  fatal: Mock;
  setContext: Mock;
  assign: Mock;
};

/**
 * A logger that records instead of writing. Every level is present, rather than the one the spec
 * happens to assert on: a partial `{ warn } as unknown as PinoLogger` answers `undefined` for the
 * level the code under test actually picks, and the cast is what hides it — the spec then passes
 * while nothing was logged.
 *
 * Assert on the spies you passed in, not on the returned logger: `PinoLogger` declares its levels as
 * methods, so `expect(logger.warn)` is an unbound method reference the lint rule rejects.
 */
export function fakePinoLogger(overrides: Partial<Record<keyof FakePinoLogger, Mock>> = {}): FakePinoLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    setContext: vi.fn(),
    assign: vi.fn(),
    ...overrides,
  } as unknown as FakePinoLogger;
}
