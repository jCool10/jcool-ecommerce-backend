import { existsSync } from 'node:fs';
import { SpanKind, SpanStatusCode, TraceFlags } from '@opentelemetry/api';
import { emptyResource, resourceFromAttributes } from '@opentelemetry/resources';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  OpenTelemetryActivityInboundInterceptor,
  OpenTelemetryActivityOutboundInterceptor,
  type SerializableSpan,
} from '@temporalio/interceptors-opentelemetry-v2';
import type { Context as ActivityContext } from '@temporalio/activity';
import type { WorkflowInfo } from '@temporalio/workflow';
import {
  type WorkflowSpanExportGlobal,
  workflowInterceptorModules,
  workflowTracingInterceptors,
  workflowTracingSinks,
} from './workflow-tracing';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';

const workflowSpan = (): SerializableSpan => ({
  name: 'RunWorkflow:CheckoutSaga',
  kind: SpanKind.INTERNAL,
  spanContext: { traceId: TRACE_ID, spanId: 'b7ad6b7169203331', traceFlags: TraceFlags.SAMPLED },
  parentSpanContext: { traceId: TRACE_ID, spanId: '00f067aa0ba902b7', traceFlags: TraceFlags.SAMPLED, isRemote: true },
  startTime: [1, 0],
  endTime: [2, 0],
  status: { code: SpanStatusCode.OK },
  attributes: {},
  links: [],
  events: [],
  duration: [1, 0],
  ended: true,
  droppedAttributesCount: 0,
  droppedLinksCount: 0,
  droppedEventsCount: 0,
  instrumentationScope: { name: '@temporalio/interceptor-workflow' },
});

const RUN = {
  namespace: 'jcool',
  taskQueue: 'checkout-saga',
  workflowType: 'CheckoutSaga',
  workflowId: 'checkout-1',
  runId: 'run-1',
  attempt: 1,
};

// What the SDK hands a sink: the whole WorkflowInfo, functions and dates included.
const workflowInfo = {
  ...RUN,
  memo: { buyerEmail: 'buyer@example.com' },
  startTime: new Date(0),
  unsafe: { isReplaying: false, now: () => 0 },
} as unknown as WorkflowInfo;

const exportFromSandbox = (span: SerializableSpan): void => {
  void workflowTracingSinks().exporter.export.fn(workflowInfo, [span]);
};

describe('workflow tracing', () => {
  const global = globalThis as WorkflowSpanExportGlobal;
  afterEach(() => {
    delete global.__workflowSpanExport;
  });

  it('hands a span from the sandbox to the published processor, under the published resource', () => {
    const onEnd = vi.fn<(span: ReadableSpan) => void>();
    const resource = resourceFromAttributes({ 'service.name': 'jcool-order-service' });
    global.__workflowSpanExport = { spanProcessor: { onEnd } as unknown as SpanProcessor, resource };

    exportFromSandbox(workflowSpan());

    expect(onEnd).toHaveBeenCalledTimes(1);
    const [span] = onEnd.mock.calls[0];
    expect(span.resource).toBe(resource);
    expect(span.spanContext()).toMatchObject({ traceId: TRACE_ID, spanId: 'b7ad6b7169203331' });
    expect(span.parentSpanContext).toMatchObject({ traceId: TRACE_ID, spanId: '00f067aa0ba902b7' });
    expect(span.instrumentationScope.name).toBe('@temporalio/interceptor-workflow');
  });

  it("names the run on each span and nothing else of the run's info", () => {
    const onEnd = vi.fn<(span: ReadableSpan) => void>();
    global.__workflowSpanExport = { spanProcessor: { onEnd } as unknown as SpanProcessor, resource: emptyResource() };

    exportFromSandbox(workflowSpan());

    expect(onEnd.mock.calls[0][0].attributes).toEqual(RUN);
  });

  it('drops spans without failing when tracing is off and nothing was published', () => {
    expect(() => exportFromSandbox(workflowSpan())).not.toThrow();
  });

  it('points the bundler at the sandbox half of the interceptor package', () => {
    const modules = workflowInterceptorModules();

    expect(modules).toHaveLength(1);
    expect(modules[0]).toMatch(/interceptors-opentelemetry-v2[\\/]lib[\\/]workflow-interceptors\.js$/);
    expect(existsSync(modules[0])).toBe(true);
  });

  it('traces every activity in and out', () => {
    const [factory] = workflowTracingInterceptors({ bundling: false }).activity ?? [];
    const interceptors = factory({ info: { activityType: 'commitStock' } } as unknown as ActivityContext);

    expect(interceptors.inbound).toBeInstanceOf(OpenTelemetryActivityInboundInterceptor);
    expect(interceptors.outbound).toBeInstanceOf(OpenTelemetryActivityOutboundInterceptor);
  });

  it('adds the workflow module only when the worker bundles at start; a prebuilt bundle already has it', () => {
    expect(workflowTracingInterceptors({ bundling: true }).workflowModules).toEqual(workflowInterceptorModules());
    expect(workflowTracingInterceptors({ bundling: false }).workflowModules).toEqual([]);
  });
});
