// Imported first by a spec that asserts spans, so the SDK patches http, express and undici before Nest,
// express and the stubs load, and the worker gets the span pipeline the production preload publishes.
// The forks pool runs each spec file in a process of its own, so none of this reaches another file.
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll } from 'vitest';
import type { WorkflowSpanExportGlobal } from '../../src/modules/order/infrastructure/temporal/workflow-tracing';
import { telemetryResource } from '../../src/telemetry-resource';

export const spanExporter = new InMemorySpanExporter();

const spanProcessor = new SimpleSpanProcessor(spanExporter);
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
  // The env list is the only way to switch every other instrumentation off.
  process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS = 'http,express,undici';
  try {
    return getNodeAutoInstrumentations({
      // Else supertest's request opens a trace of its own and overwrites the traceparent a test sets.
      '@opentelemetry/instrumentation-http': { ignoreOutgoingRequestHook: () => true },
    });
  } finally {
    delete process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS;
  }
}
