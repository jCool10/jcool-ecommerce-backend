import pino from 'pino';
import { flushLogsSync, getLogDestination } from './log-destination';
import { ISO_TIMESTAMP, levelAsWord } from './wire-format';

/** Just enough of a logger for the two death paths — so a spec can pass a double, not a container. */
export interface FatalLogger {
  fatal(obj: Record<string, unknown>, msg: string): void;
}

/** Identity fields for the bootstrap logger, which runs before any ConfigService exists. */
export interface BootstrapLogIdentity {
  service: string;
  env: string | undefined;
  version: string;
}

export interface FatalHandlerHooks {
  /**
   * Bounded last chance for an async error reporter to ship the crash. Registering an
   * `uncaughtException` handler makes Sentry's own integration stop owning the exit, so without
   * this the synchronous exit below kills its in-flight transport and the crash — the one event
   * most worth having — never leaves the process.
   */
  drain?: () => Promise<unknown>;
  /** Injectable so a spec can assert the log→flush→drain→exit order without killing the runner. */
  exit?: (code: number) => void;
}

const PROCESS_CONTEXT = 'Process';

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * Turn the two deaths that happen outside every try/catch into one structured line each.
 *
 * Without this, Node prints a raw stack to stderr: no requestId, no service, no version, not
 * parseable — so the single line an on-call person most needs is the only one the log platform
 * never receives.
 *
 * Both handlers exit. After an uncaught exception the process is in an undefined state and
 * carrying on is worse than restarting; for an unhandled rejection, exiting is already Node's
 * default (`--unhandled-rejections=throw`), and catching *without* exiting would silently change
 * the runtime's contract and leave a half-dead process serving traffic. All this adds is the line.
 *
 * Order is log → flush → drain → exit: the line reaches stdout before anything that can hang.
 */
export function registerFatalHandlers(logger: FatalLogger, hooks: FatalHandlerHooks = {}): void {
  const { drain, exit = (code: number) => process.exit(code) } = hooks;

  async function die(reason: unknown, message: string): Promise<void> {
    // A rejection can carry anything (`Promise.reject('nope')`); pino's err serializer needs an
    // Error to produce a stack, so normalize rather than log a bare string.
    logger.fatal({ context: PROCESS_CONTEXT, err: toError(reason) }, message);
    flushLogsSync();
    try {
      await drain?.();
    } catch {
      // a reporter that cannot flush must not stop the process from leaving
    }
    exit(1);
  }

  process.on('uncaughtException', (err: Error) => {
    void die(err, 'uncaught exception — shutting down');
  });

  process.on('unhandledRejection', (reason: unknown) => {
    void die(reason, 'unhandled promise rejection — shutting down');
  });
}

/**
 * Report a failure to boot in the same JSON shape as the rest of production.
 *
 * `bootstrap()` can fail before `app.useLogger(pino)` runs, and NestJS's own console format is the
 * one output a log platform cannot parse — on the one event that is always worth reading. Uses a
 * standalone pino on the shared destination because there is, by definition, no container to ask.
 */
export function logBootstrapFailure(error: unknown, identity: BootstrapLogIdentity): void {
  const logger = pino(
    {
      level: 'fatal',
      base: identity,
      timestamp: ISO_TIMESTAMP,
      formatters: { level: levelAsWord },
    },
    getLogDestination(),
  );
  logger.fatal({ context: 'Bootstrap', err: toError(error) }, 'bootstrap failed');
}
