import { Injectable, OnApplicationShutdown } from '@nestjs/common';

/**
 * Shape the preloaded instrumentation publishes on globalThis. A global handle rather than an
 * import: importing instrumentation.ts would initialize a second SDK when the app runs without
 * `--import`.
 */
export interface TelemetryFlushGlobal {
  __flushTelemetry?: () => Promise<void>;
}

/**
 * Nest awaits onApplicationShutdown, so the OTel/Sentry flush lands AFTER the readiness grace period
 * and the HTTP server close — spans and errors produced while the pod drains still get exported.
 */
@Injectable()
export class TelemetryFlushService implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await (globalThis as TelemetryFlushGlobal).__flushTelemetry?.();
  }
}
