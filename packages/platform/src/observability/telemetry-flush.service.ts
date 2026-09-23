import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

const LOG_CONTEXT = 'TelemetryFlushService';

/**
 * Shape the preloaded instrumentation publishes on globalThis. A global handle rather than an
 * import: importing instrumentation.ts would initialize a second SDK when the app runs without
 * `--import`.
 */
export interface TelemetryFlushGlobal {
  __flushTelemetry?: () => Promise<'flushed' | 'timed_out'>;
}

/**
 * Nest awaits onApplicationShutdown, so the OTel/Sentry flush lands AFTER the readiness grace period
 * and the HTTP server close — spans and errors produced while the pod drains still get exported.
 */
@Injectable()
export class TelemetryFlushService implements OnApplicationShutdown {
  constructor(private readonly logger: PinoLogger) {
    logger.setContext(LOG_CONTEXT);
  }

  async onApplicationShutdown(): Promise<void> {
    const flush = (globalThis as TelemetryFlushGlobal).__flushTelemetry;
    if (!flush) return; // No instrumentation preload (dev, tests) — nothing to flush.

    const startedAt = process.hrtime.bigint();
    const outcome = await flush();
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    if (outcome === 'flushed') {
      this.logger.info({ seconds }, 'telemetry flushed on shutdown');
    } else {
      this.logger.warn(
        { seconds },
        'telemetry flush hit its ceiling on shutdown — drain-window spans and errors may be lost',
      );
    }
  }
}
