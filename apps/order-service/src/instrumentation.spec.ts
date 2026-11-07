import { diag } from '@opentelemetry/api';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelemetryFlushGlobal } from '@jcool/platform/observability';
import { autoInstrumentationConfig, ScrubbingSpanExporter } from '@jcool/platform/telemetry';
import type { WorkflowSpanExportGlobal } from './modules/order/infrastructure/temporal/workflow-tracing';

const workflowGlobal = globalThis as WorkflowSpanExportGlobal;

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
  vi.doMock('@opentelemetry/sdk-trace-base', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    BatchSpanProcessor: class {
      constructor(readonly exporter: SpanExporter) {}
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
  vi.doUnmock('@opentelemetry/sdk-trace-base');
  vi.resetModules();
  vi.unstubAllEnvs();
  delete (globalThis as TelemetryFlushGlobal).__flushTelemetry;
  delete workflowGlobal.__workflowSpanExport;
  diag.disable();
});

// Spans leave the process for a third-party backend, so only through the scrubber.
describe('trace export wiring', () => {
  // The worker hands the Temporal sandbox's workflow spans to the published processor.
  it('exports every span, the workflow spans included, through the scrubbing exporter', async () => {
    const { sdkConfig } = await exportingPreload();
    const processors = sdkConfig.spanProcessors as { exporter: SpanExporter }[];

    expect(processors).toHaveLength(1);
    expect(processors[0].exporter).toBeInstanceOf(ScrubbingSpanExporter);
    expect(workflowGlobal.__workflowSpanExport?.spanProcessor).toBe(processors[0]);
  });

  it('instruments with the shared configuration', async () => {
    const { instrumentationConfig } = await exportingPreload();

    expect(instrumentationConfig).toEqual(autoInstrumentationConfig());
  });

  it('starts no metrics or logs pipeline next to the traces', async () => {
    const { sdkConfig } = await exportingPreload();

    expect(sdkConfig).toMatchObject({ metricReaders: [], logRecordProcessors: [] });
  });
});
