import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach } from 'vitest';

/**
 * Registers a real tracer and context manager for the enclosing suite; unit runs have no OTel SDK,
 * so without this every span is a no-op. Returns the exporter, emptied before each test.
 */
export function useInMemoryTracer(): InMemorySpanExporter {
  const exporter = new InMemorySpanExporter();
  let provider: BasicTracerProvider;

  beforeAll(() => {
    context.disable();
    trace.disable();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(provider);
  });

  beforeEach(() => exporter.reset());

  afterAll(async () => {
    await provider.shutdown();
    context.disable();
    trace.disable();
  });

  return exporter;
}
