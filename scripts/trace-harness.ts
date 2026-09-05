/**
 * Cross-process trace propagation demo:
 *   npx tsx scripts/trace-harness.ts          # 3 spans share ONE traceId
 *   npx tsx scripts/trace-harness.ts --break   # drop the inject → trace splits in two
 *
 * A PRODUCER injects the active context into a message carrier; a CONSUMER extracts it and
 * continues the SAME trace (two in-process spans stand in for the two processes). Uses the
 * app's real injectTraceContext/extractTraceContext and a self-contained ConsoleSpanExporter,
 * so it needs no Collector.
 */
import { SpanKind, context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { extractTraceContext, injectTraceContext } from '../src/shared/observability/tracing/propagation';

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

  // PROCESS A — inbound HTTP request that produces an "order.placed" message.
  tracer.startActiveSpan('SERVER POST /orders', { kind: SpanKind.SERVER }, (server) => {
    traceIds.server = server.spanContext().traceId;
    tracer.startActiveSpan('PRODUCER order.placed', { kind: SpanKind.PRODUCER }, (producer) => {
      traceIds.producer = producer.spanContext().traceId;
      // The join step: serialise the active trace context into the message headers.
      if (!broken) injectTraceContext(carrier);
      producer.end();
    });
    server.end();
  });

  // PROCESS B — worker consumes the message, rebuilding the parent context from the carrier.
  // With no traceparent (--break) it starts a brand-new, disconnected trace.
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

  // Expected: whole when injected, split when broken. Exit non-zero if reality disagrees.
  const asExpected = broken ? !oneTrace : oneTrace;
  await provider.shutdown();
  process.exit(asExpected ? 0 : 1);
}

void main();
