import { DefaultLogger, type LogEntry, Runtime } from '@temporalio/worker';
import { toError } from '@jcool/kernel';
import type { PinoLogger } from 'nestjs-pino';

/**
 * Idempotent per process. No shutdown signals: Nest owns SIGTERM, and the SDK's own handler would
 * stop the worker before the drain steps run. WARN keeps worker state chatter out of the logs while
 * workflow warnings (an ignored authorization, a stale write) still surface, through pino when given
 * one so they reach Loki with the rest. Core's own logs would go straight to stderr unless forwarded.
 */
export function installTemporalRuntime(logger?: PinoLogger): void {
  if (Runtime._instance) return;
  Runtime.install({
    shutdownSignals: [],
    logger: new DefaultLogger('WARN', logger && toPino(logger)),
    telemetryOptions: { logging: { filter: { core: 'WARN' }, forward: {} } },
  });
}

const toPino =
  (logger: PinoLogger) =>
  ({ level, message, meta }: LogEntry): void => {
    const { error, ...fields } = meta ?? {};
    const entry = error === undefined ? fields : { ...fields, err: toError(error) };
    if (level === 'ERROR') logger.error(entry, message);
    else logger.warn(entry, message);
  };
