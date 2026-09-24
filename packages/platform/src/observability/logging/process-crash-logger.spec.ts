import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { logProcessCrashes } from './process-crash-logger';

type Monitor = (error: unknown, origin: NodeJS.UncaughtExceptionOrigin) => void;

describe('logProcessCrashes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs a crash as one fatal line from a monitor that leaves Node to exit', () => {
    const on = vi.spyOn(process, 'on').mockReturnValue(process);
    const fatal = vi.fn();
    const error = new Error('connection terminated unexpectedly');

    logProcessCrashes(fakePinoLogger({ fatal }));
    // An 'uncaughtException' or 'unhandledRejection' listener would keep the process alive.
    expect(on).toHaveBeenCalledExactlyOnceWith('uncaughtExceptionMonitor', expect.any(Function));
    (on.mock.calls[0][1] as Monitor)(error, 'unhandledRejection');

    expect(fatal).toHaveBeenCalledExactlyOnceWith(
      { err: error, origin: 'unhandledRejection' },
      'process crashing on an uncaught error',
    );
  });
});
