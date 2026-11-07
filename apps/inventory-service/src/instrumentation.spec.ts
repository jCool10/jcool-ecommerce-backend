import { diag } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelemetryFlushGlobal } from '@jcool/platform/observability';
import { autoInstrumentationConfig, ScrubbingSpanExporter } from '@jcool/platform/telemetry';

// Loads the real preload with the SDK stubbed, so what is under test is the shipped wiring.
async function exportingPreload(): Promise<{ sdkConfig: Record<string, unknown>; instrumentationConfig: unknown }> {
  let sdkConfig: Record<string, unknown> | undefined;
  let instrumentationConfig: unknown;
  vi.doMock('@sentry/nestjs', () => ({}));
  vi.doMock('@opentelemetry/sdk-node', () => ({
    NodeSDK: class {
      constructor(config: Record<string, unknown>) {
        sdkConfig = config;
      }
      start(): void {}
      shutdown = (): Promise<void> => Promise.resolve();
    },
  }));
  // Real instrumentations would patch modules in this worker for the rest of the run.
  vi.doMock('@opentelemetry/auto-instrumentations-node', () => ({
    getNodeAutoInstrumentations: (config: unknown) => {
      instrumentationConfig = config;
      return [];
    },
  }));
  vi.stubEnv('OTEL_ENABLED', 'true');
  vi.stubEnv('SENTRY_DSN', undefined);

  // `.js` because a dynamic import is resolved as ESM even from a CJS-emitted spec.
  await import('./instrumentation.js');
  if (!sdkConfig) throw new Error('instrumentation built no NodeSDK');
  return { sdkConfig, instrumentationConfig };
}

afterEach(() => {
  vi.doUnmock('@sentry/nestjs');
  vi.doUnmock('@opentelemetry/sdk-node');
  vi.doUnmock('@opentelemetry/auto-instrumentations-node');
  vi.resetModules();
  vi.unstubAllEnvs();
  delete (globalThis as TelemetryFlushGlobal).__flushTelemetry;
  diag.disable();
});

// Spans leave the process for a third-party backend, so only through the scrubber.
describe('trace export wiring', () => {
  it('exports every span through the scrubbing exporter, instrumented with the shared configuration', async () => {
    const { sdkConfig, instrumentationConfig } = await exportingPreload();

    expect(sdkConfig.traceExporter).toBeInstanceOf(ScrubbingSpanExporter);
    expect(instrumentationConfig).toEqual(autoInstrumentationConfig());
  });

  it('starts no metrics or logs pipeline next to the traces', async () => {
    const { sdkConfig } = await exportingPreload();

    expect(sdkConfig).toMatchObject({ metricReaders: [], logRecordProcessors: [] });
  });
});
