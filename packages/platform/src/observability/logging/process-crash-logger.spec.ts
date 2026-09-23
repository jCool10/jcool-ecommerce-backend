import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { logProcessCrashes } from './process-crash-logger';

type Monitor = (error: unknown, origin: NodeJS.UncaughtExceptionOrigin) => void;

describe('logProcessCrashes', () => {
  afterEach(() => vi.restoreAllMocks());

  function install(fatal = vi.fn()): Monitor {
    const on = vi.spyOn(process, 'on').mockReturnValue(process);
    logProcessCrashes(fakePinoLogger({ fatal }));
    // Only the monitor: an 'uncaughtException' or 'unhandledRejection' listener would stop Node exiting.
    expect(on).toHaveBeenCalledExactlyOnceWith('uncaughtExceptionMonitor', expect.any(Function));
    return on.mock.calls[0][1] as Monitor;
  }

  it('logs the crash as one fatal line with its origin', () => {
    const fatal = vi.fn();
    const monitor = install(fatal);
    const error = new Error('connection terminated unexpectedly');

    monitor(error, 'unhandledRejection');

    expect(fatal).toHaveBeenCalledExactlyOnceWith(
      { err: error, origin: 'unhandledRejection' },
      'process crashing on an uncaught error',
    );
  });

  it('normalizes a thrown non-Error into err', () => {
    const fatal = vi.fn();
    const monitor = install(fatal);

    monitor('socket hang up', 'uncaughtException');

    expect(fatal).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'socket hang up' }) as unknown, origin: 'uncaughtException' },
      'process crashing on an uncaught error',
    );
  });
});
