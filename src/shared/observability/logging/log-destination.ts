import pino, { type DestinationStream } from 'pino';

type FlushableDestination = DestinationStream & { flushSync(): void };

let destination: FlushableDestination | undefined;

/**
 * Production's log sink: an async SonicBoom on fd 1 that batches writes up to `minLength` instead
 * of paying a `write()` syscall per line, which a busy request otherwise does several times.
 *
 * Singleton because the shutdown hook has to flush the very stream the logger writes into — two
 * instances would flush one buffer and drop the other, and nothing would say so.
 *
 * Dev and test deliberately do not use it: dev goes through the pino-pretty transport, and test
 * keeps pino's default unbatched destination so a failing suite's last lines are on screen rather
 * than sitting in a 4 KB buffer nobody flushes.
 */
export function getLogDestination(): FlushableDestination {
  // `periodicFlush` is what makes the batching safe on a quiet service: without it a lone 5xx sits
  // in the buffer until 4 KB of later traffic pushes it out, which on a low-volume deploy can be
  // hours — the log platform would show nothing at exactly the moment someone is looking.
  destination ??= pino.destination({ dest: 1, sync: false, minLength: 4096, periodicFlush: 1000 });
  return destination;
}

/**
 * Push whatever is buffered out to fd 1, blocking. Call it on EVERY way out of the process —
 * SIGTERM during a rolling deploy, an uncaught exception, `beforeExit` — because the lines still
 * in the buffer are the ones describing why the process is leaving.
 *
 * A no-op when no batched destination was created (dev/test). Failures are swallowed on purpose:
 * we are already on the way out and there is nowhere left to report to, and a throw here would
 * replace the real cause of death with a logging error.
 */
export function flushLogsSync(): void {
  try {
    destination?.flushSync();
  } catch {
    // deliberately silent — see above
  }
}
