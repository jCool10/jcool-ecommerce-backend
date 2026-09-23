import type { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';

const LOG_CONTEXT = 'Process';

/** A monitor, not a handler: the process still crashes as Node would, but the reason is logged first. */
export function logProcessCrashes(logger: PinoLogger): void {
  logger.setContext(LOG_CONTEXT);
  process.on('uncaughtExceptionMonitor', (error: unknown, origin: NodeJS.UncaughtExceptionOrigin) => {
    logger.fatal({ err: toError(error), origin }, 'process crashing on an uncaught error');
  });
}
