/**
 * Cross-process trace propagation demo: `npx tsx scripts/trace-harness.ts`, `--break` to drop the
 * inject. Two in-process spans stand in for the two processes, over the app's real inject/extract
 * helpers and a self-contained ConsoleSpanExporter, so it needs no Collector.
 */
import { SpanKind, context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { extractTraceContext, injectTraceContext } from '@shared/observability/tracing/propagation';

const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
});
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
trace.setGlobalTracerProvider(provider);

const tracer = trace.getTracer('trace-harness');
const broken = process.argv.includes('--break');

async function main(): Promise<void> {
  const carrier: Record<string, string> = {};
  const traceIds: { server?: string; producer?: string; consumer?: string } = {};

  tracer.startActiveSpan('SERVER POST /orders', { kind: SpanKind.SERVER }, (server) => {
    traceIds.server = server.spanContext().traceId;
    tracer.startActiveSpan('PRODUCER order.placed', { kind: SpanKind.PRODUCER }, (producer) => {
      traceIds.producer = producer.spanContext().traceId;
      if (!broken) injectTraceContext(carrier);
      producer.end();
    });
    server.end();
  });

  // With no traceparent (--break) the extract yields an empty context and the consumer starts a
  // brand-new, disconnected trace.
  const parentContext = extractTraceContext(carrier);
  context.with(parentContext, () => {
    tracer.startActiveSpan('CONSUMER order.placed', { kind: SpanKind.CONSUMER }, (consumer) => {
      traceIds.consumer = consumer.spanContext().traceId;
      consumer.end();
    });
  });

  await provider.forceFlush();

  const oneTrace = traceIds.server === traceIds.producer && traceIds.producer === traceIds.consumer;
  console.log('\n--- trace-harness result ---');
  console.log(`traceparent injected : ${!broken}`);
  console.log(`SERVER   traceId     : ${traceIds.server}`);
  console.log(`PRODUCER traceId     : ${traceIds.producer}`);
  console.log(`CONSUMER traceId     : ${traceIds.consumer}`);
  console.log(oneTrace ? '✓ ONE trace: all 3 spans share a traceId' : '✗ SPLIT: consumer started a new trace');

  const asExpected = broken ? !oneTrace : oneTrace;
  await provider.shutdown();
  process.exit(asExpected ? 0 : 1);
}

void main();
