// Imported first by a spec that asserts spans, so the SDK patches http, express and undici before Nest,
// express and the stubs load, and the worker gets the span pipeline the production preload publishes.
// The forks pool runs each spec file in a process of its own, so none of this reaches another file.
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll } from 'vitest';
import { ScrubbingSpanExporter, autoInstrumentationConfig } from '@jcool/platform/telemetry';
import type { WorkflowSpanExportGlobal } from '../../src/modules/order/infrastructure/temporal/workflow-tracing';
import { telemetryResource } from '../../src/telemetry-resource';

/** Holds what production would send to the backend: every span here has been scrubbed. */
export const spanExporter = new InMemorySpanExporter();

const spanProcessor = new SimpleSpanProcessor(new ScrubbingSpanExporter(spanExporter));
const resource = telemetryResource('jcool-order-service');
const sdk = new NodeSDK({
  resource,
  autoDetectResources: false,
  spanProcessors: [spanProcessor],
  instrumentations: [instrumentations()],
});

sdk.start();
(globalThis as WorkflowSpanExportGlobal).__workflowSpanExport = { spanProcessor, resource };

// Until host detection settles, the simple processor holds each ended span back.
beforeAll(async () => {
  await resource.waitForAsyncAttributes?.();
});

afterAll(async () => {
  await sdk.shutdown();
});

function instrumentations(): ReturnType<typeof getNodeAutoInstrumentations> {
  const production = autoInstrumentationConfig();
  // The env list is the only way to switch every other instrumentation off. The request path's
  // instrumentations take production's settings, so a span production would make is made here too.
  process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS = 'http,express,router,undici';
  try {
    return getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': {
        ...production['@opentelemetry/instrumentation-http'],
        // Else supertest's request opens a trace of its own and overwrites the traceparent a test sets.
        ignoreOutgoingRequestHook: () => true,
      },
      '@opentelemetry/instrumentation-express': production['@opentelemetry/instrumentation-express'],
      '@opentelemetry/instrumentation-router': production['@opentelemetry/instrumentation-router'],
      '@opentelemetry/instrumentation-undici': production['@opentelemetry/instrumentation-undici'],
    });
  } finally {
    delete process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS;
  }
}
