import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { type Resource, emptyResource } from '@opentelemetry/resources';
import { NoopSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  OpenTelemetryActivityInboundInterceptor,
  OpenTelemetryActivityOutboundInterceptor,
  type OpenTelemetrySinks,
  makeWorkflowExporter,
} from '@temporalio/interceptors-opentelemetry-v2';
import type { InjectedSinks, WorkerInterceptors } from '@temporalio/worker';
import type { WorkflowInfo } from '@temporalio/workflow';

const SANDBOX_INTERCEPTORS = '@temporalio/interceptors-opentelemetry-v2/lib/workflow-interceptors';

/** What the preload hands the worker, so workflow spans join the pipeline every other span takes. */
export interface WorkflowSpanExport {
  spanProcessor: SpanProcessor;
  resource: Resource;
}

export type WorkflowSpanExportGlobal = typeof globalThis & { __workflowSpanExport?: WorkflowSpanExport };

/**
 * The sandbox half of the interceptors, for the bundler. Resolved from the app directory like
 * `WORKFLOWS_SOURCE`: this file is CJS in the app and ESM under vitest.
 */
export function workflowInterceptorModules(): string[] {
  return [createRequire(resolve('package.json')).resolve(SANDBOX_INTERCEPTORS)];
}

/** A prebuilt bundle already carries the workflow module; naming it again only makes the SDK warn. */
export function workflowTracingInterceptors({ bundling }: { bundling: boolean }): WorkerInterceptors {
  return {
    activity: [
      (ctx) => ({
        inbound: new OpenTelemetryActivityInboundInterceptor(ctx),
        outbound: new OpenTelemetryActivityOutboundInterceptor(ctx),
      }),
    ],
    workflowModules: bundling ? workflowInterceptorModules() : [],
  };
}

/**
 * Registered with tracing off too: the sandbox spans every run, and a call to an unregistered sink is
 * logged as an error. Read at worker start, after the preload has published.
 */
export function workflowTracingSinks(): InjectedSinks<OpenTelemetrySinks> {
  const published = (globalThis as WorkflowSpanExportGlobal).__workflowSpanExport;
  const { export: exportSpans } = makeWorkflowExporter(
    published?.spanProcessor ?? new NoopSpanProcessor(),
    published?.resource ?? emptyResource(),
  );
  return { exporter: { export: { ...exportSpans, fn: (info, spans) => exportSpans.fn(runOf(info), spans) } } };
}

/**
 * The interceptors stamp `trace_id`, `span_id` and `trace_flags` on every workflow log line, tracing
 * off or not. Under the platform's `traceId`/`spanId` keys when spans are exported; dropped otherwise,
 * since the sandbox's ids then name a trace no backend has.
 */
export function traceLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  const { trace_id: traceId, span_id: spanId, trace_flags: _flags, ...rest } = fields;
  const exported = (globalThis as WorkflowSpanExportGlobal).__workflowSpanExport !== undefined;
  return exported && traceId !== undefined ? { ...rest, traceId, spanId } : rest;
}

// The exporter copies whatever info it gets onto every span's attributes; the full WorkflowInfo holds
// functions, dates, the memo and the search attributes, none of which a span should carry.
const runOf = ({ namespace, taskQueue, workflowType, workflowId, runId, attempt }: WorkflowInfo): WorkflowInfo =>
  ({ namespace, taskQueue, workflowType, workflowId, runId, attempt }) as WorkflowInfo;
