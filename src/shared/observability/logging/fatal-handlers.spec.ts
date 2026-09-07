import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerFatalHandlers } from './fatal-handlers';

type DeathEvent = 'uncaughtException' | 'unhandledRejection';
type DeathListener = (arg: unknown) => void;

// Emitting the real events would take the test runner down with the process, so drive the
// listeners this module registers directly.
function listenersFor(event: DeathEvent): DeathListener[] {
  return (process.listeners as (name: string) => DeathListener[])(event);
}

describe('registerFatalHandlers', () => {
  const fatal = vi.fn<(obj: Record<string, unknown>, msg: string) => void>();
  const exit = vi.fn<(code: number) => void>();
  const drain = vi.fn<() => Promise<unknown>>();
  let before: Record<DeathEvent, number>;

  beforeEach(() => {
    fatal.mockReset();
    exit.mockReset();
    drain.mockReset();
    drain.mockResolvedValue(undefined);
    before = {
      uncaughtException: listenersFor('uncaughtException').length,
      unhandledRejection: listenersFor('unhandledRejection').length,
    };
    registerFatalHandlers({ fatal }, { exit, drain });
  });

  afterEach(() => {
    // Leave the runner's own handlers exactly as they were.
    for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
      for (const listener of listenersFor(event).slice(before[event])) {
        process.off(event, listener);
      }
    }
  });

  // The handler is async (it awaits the drain), so let its microtasks settle before asserting.
  async function fire(event: DeathEvent, arg: unknown): Promise<void> {
    listenersFor(event).at(-1)?.(arg);
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  }

  it('logs an uncaught exception as fatal, then exits 1', async () => {
    const boom = new Error('boom');

    await fire('uncaughtException', boom);

    expect(fatal).toHaveBeenCalledWith(
      expect.objectContaining({ context: 'Process', err: boom }),
      expect.stringContaining('uncaught exception'),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  // The line is the whole point of the handler, and the drain is Sentry's only chance to ship the
  // crash — both have to happen before the process leaves.
  it('logs, then drains the error reporter, then exits', async () => {
    const order: string[] = [];
    fatal.mockImplementation(() => void order.push('log'));
    drain.mockImplementation(() => Promise.resolve(order.push('drain')));
    exit.mockImplementation(() => void order.push('exit'));

    await fire('uncaughtException', new Error('boom'));

    expect(order).toEqual(['log', 'drain', 'exit']);
  });

  // A reporter that cannot flush must not turn a crash into a hang or swallow the exit.
  it('still exits when the drain rejects', async () => {
    drain.mockRejectedValue(new Error('sentry unreachable'));

    await fire('uncaughtException', new Error('boom'));

    expect(exit).toHaveBeenCalledWith(1);
  });

  // pino's err serializer needs an Error to produce a stack; a rejection can carry anything.
  it('normalizes a non-Error rejection reason so the line still carries a stack', async () => {
    await fire('unhandledRejection', 'nope');

    const err = fatal.mock.calls[0][0].err as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('nope');
    expect(err.stack).toBeDefined();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('passes an Error rejection reason through untouched', async () => {
    const cause = new Error('rejected');

    await fire('unhandledRejection', cause);

    expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ err: cause }), expect.any(String));
  });

  it('registers exactly one handler per death path', () => {
    expect(listenersFor('uncaughtException').length).toBe(before.uncaughtException + 1);
    expect(listenersFor('unhandledRejection').length).toBe(before.unhandledRejection + 1);
  });
});
