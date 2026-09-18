import { context } from '@opentelemetry/api';
import { extractTraceContext, withSpan } from '@jcool/platform/observability';

/**
 * Auto-instrumentation cannot follow an async hop, so without this the work a queued event triggers
 * shows up as an orphan trace with no visible cause. A missing traceparent is normal, not an error
 * (an event written with the SDK off), and simply starts a new trace rather than dropping the span.
 */
export function withConsumeSpan<T>(eventType: string, traceparent: string | null, fn: () => Promise<T>): Promise<T> {
  const parent = traceparent ? extractTraceContext({ traceparent }) : context.active();

  return context.with(parent, () => withSpan(`consume:${eventType}`, () => fn()));
}
