import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelemetryFlushGlobal } from '../telemetry-flush.service';

const telemetryGlobal = globalThis as TelemetryFlushGlobal;

// Must match FLUSH_TIMEOUT_MS in start-telemetry.ts — the ceiling is a deliberate number, not a
// detail: it is what has to fit inside terminationGracePeriodSeconds next to the readiness grace.
const FLUSH_CEILING_MS = 3000;

afterEach(() => {
  delete telemetryGlobal.__flushTelemetry;
});

// The consumer of the handle published here — TelemetryFlushService — is tested separately; these
// cases cover the half only the preload owns: the flush budget, and the two sinks racing rather
// than chaining.
describe('telemetry preload', () => {
  // Loads the real preload with its telemetry clients stubbed, so the published handle under test is
  // the shipped one. `sentryFlush` is the spy each case asserts on.
  async function withTelemetry(
    env: Record<string, string | undefined>,
    otelShutdown: () => Promise<void>,
    body: (flush: () => Promise<void>, sentryFlush: ReturnType<typeof vi.fn>) => Promise<void>,
  ): Promise<void> {
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const sentryFlush = vi.fn(() => Promise.resolve(true));
    vi.doMock('@sentry/nestjs', () => ({
      init: (): void => undefined,
      httpIntegration: (): Record<string, never> => ({}),
      SentryContextManager: class {},
      flush: sentryFlush,
    }));
    vi.doMock('@opentelemetry/sdk-node', () => ({
      NodeSDK: class {
        start(): void {}
        shutdown = otelShutdown;
      },
    }));

    try {
      // `.js` because a dynamic import is resolved as ESM even from a CJS-emitted spec.
      const { startTelemetry } = await import('./start-telemetry.js');
      startTelemetry('jcool-test');
      const flush = telemetryGlobal.__flushTelemetry;
      if (!flush) throw new Error('the preload published no flush handle');
      await body(flush, sentryFlush);
    } finally {
      vi.useRealTimers();
      vi.doUnmock('@sentry/nestjs');
      vi.doUnmock('@opentelemetry/sdk-node');
      vi.resetModules();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  const never = (): Promise<void> => new Promise<void>(() => undefined);

  it('gives up on a flush that never lands, so a dead telemetry sink cannot stall the exit', async () => {
    await withTelemetry(
      { SENTRY_DSN: 'https://public@sentry.invalid/1', OTEL_ENABLED: 'true' },
      never,
      async (flush) => {
        vi.useFakeTimers();
        let settled = false;
        void flush().then(() => {
          settled = true;
        });

        await vi.advanceTimersByTimeAsync(FLUSH_CEILING_MS - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(true);
      },
    );
  });

  // A blackholed OTLP endpoint is the case the ceiling exists for, and it is also when Sentry holds
  // the errors worth keeping. Chaining the two flushes would spend the whole budget on the collector.
  it('still flushes Sentry when the OTLP shutdown never returns', async () => {
    await withTelemetry(
      { SENTRY_DSN: 'https://public@sentry.invalid/1', OTEL_ENABLED: 'true' },
      never,
      async (flush, sentryFlush) => {
        vi.useFakeTimers();
        void flush();
        // One microtask is all it takes: both flushes are started together, so Sentry's is already
        // in flight. Awaiting the OTLP shutdown first would leave this at zero calls forever.
        await Promise.resolve();

        expect(sentryFlush).toHaveBeenCalledOnce();
      },
    );
  });
});
