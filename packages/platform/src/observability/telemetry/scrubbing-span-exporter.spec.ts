import { type Attributes, type Span, SpanStatusCode, type Tracer, context, trace } from '@opentelemetry/api';
import { type ExportResult, ExportResultCode } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it, vi } from 'vitest';
import { ScrubbingSpanExporter } from './scrubbing-span-exporter';

const PARSE_ERROR = `Unexpected token 'h', ..."password":hunter2}" is not valid JSON`;

/** Ends one span through the real SDK and returns it as the backend would get it, next to the original. */
function recorded(build: (tracer: Tracer) => Span): { raw: ReadableSpan; scrubbed: ReadableSpan } {
  const raw = new InMemorySpanExporter();
  const scrubbed = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(raw), new SimpleSpanProcessor(new ScrubbingSpanExporter(scrubbed))],
  });
  const span = build(provider.getTracer('spec'));
  span.end();
  const built = (exporter: InMemorySpanExporter): ReadableSpan => {
    const found = exporter.getFinishedSpans().find((ended) => ended.spanContext().spanId === span.spanContext().spanId);
    if (!found) throw new Error('the span under test was not exported');
    return found;
  };
  return { raw: built(raw), scrubbed: built(scrubbed) };
}

const scrubbedAttributes = (attributes: Attributes): Attributes =>
  recorded((tracer) => tracer.startSpan('op', { attributes })).scrubbed.attributes;

const fieldsOf = (span: ReadableSpan) => ({
  name: span.name,
  kind: span.kind,
  spanContext: span.spanContext(),
  parentSpanContext: span.parentSpanContext,
  startTime: span.startTime,
  endTime: span.endTime,
  duration: span.duration,
  ended: span.ended,
  status: span.status,
  attributes: span.attributes,
  links: span.links,
  events: span.events,
  resource: span.resource,
  instrumentationScope: span.instrumentationScope,
  droppedAttributesCount: span.droppedAttributesCount,
  droppedEventsCount: span.droppedEventsCount,
  droppedLinksCount: span.droppedLinksCount,
});

describe('ScrubbingSpanExporter', () => {
  it('drops an attribute when any dotted segment of its key names a credential', () => {
    expect(
      scrubbedAttributes({
        'http.request.header.authorization': ['Bearer abc'],
        'http.request.header.cookie': ['sid=abc'],
        'http.response.header.set-cookie': ['sid=abc'],
        'http.response.header.set_cookie': ['sid=abc'],
        'http.request.header.idempotency-key': ['key-1'],
        'http.request.header.idempotency_key': ['key-1'],
        'app.refreshToken': 'abc',
        'http.route': '/orders',
      }),
    ).toEqual({ 'http.route': '/orders' });
  });

  it('drops client addresses, user identities, the database user and the raw query', () => {
    expect(
      scrubbedAttributes({
        'client.address': '198.51.100.7',
        'http.client_ip': '198.51.100.7',
        'user.email': 'buyer@example.com',
        'enduser.id': '42',
        'db.user': 'app',
        'url.query': 'token=abc',
        'url.path': '/orders',
      }),
    ).toEqual({ 'url.path': '/orders' });
  });

  it('cuts the query string off every url attribute', () => {
    expect(
      scrubbedAttributes({
        'url.full': 'https://shop.test/auth/verify-email?token=abc',
        'http.url': 'http://order-service:3000/orders?page=2',
        'http.target': '/auth/reset-password?token=abc',
      }),
    ).toEqual({
      'url.full': 'https://shop.test/auth/verify-email',
      'http.url': 'http://order-service:3000/orders',
      'http.target': '/auth/reset-password',
    });
  });

  it('replaces a JSON parse error with a fixed line wherever it appears', () => {
    const { scrubbed } = recorded((tracer) => {
      const span = tracer.startSpan('middleware - jsonParser');
      span.recordException(new SyntaxError(PARSE_ERROR));
      span.setStatus({ code: SpanStatusCode.ERROR, message: PARSE_ERROR });
      return span;
    });

    expect(scrubbed.events[0].attributes).toEqual({
      'exception.type': 'SyntaxError',
      'exception.message': 'malformed request body',
      'exception.stacktrace': 'malformed request body',
    });
    expect(scrubbed.status).toEqual({ code: SpanStatusCode.ERROR, message: 'malformed request body' });
  });

  it('redacts email addresses and Stripe secrets inside any other string', () => {
    expect(
      scrubbedAttributes({
        'db.statement': 'select 1 -- buyer@example.com',
        'app.keys': ['sk_live_51Habc', 'rk_test_51Habc', 'kept'],
        'app.note': 'whsec_abc123 then pi_3Pabc_secret_xyz9',
        'http.status_code': 500,
      }),
    ).toEqual({
      'db.statement': 'select 1 -- [redacted]',
      'app.keys': ['[redacted]', '[redacted]', 'kept'],
      'app.note': '[redacted] then [redacted]',
      'http.status_code': 500,
    });

    const { scrubbed } = recorded((tracer) => {
      const span = tracer.startSpan('op');
      span.recordException(new Error('no account for buyer@example.com'));
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'no account for buyer@example.com' });
      return span;
    });
    expect(scrubbed.events[0].attributes?.['exception.message']).toBe('no account for [redacted]');
    expect(JSON.stringify(scrubbed.events)).not.toContain('buyer@example.com');
    expect(scrubbed.status.message).toBe('no account for [redacted]');
  });

  // A client picks the request path and the user agent, and scrubbing runs on the event loop.
  it('scrubs a long unbroken string in time proportional to its length', () => {
    const run = 'a'.repeat(32_000);
    const started = performance.now();

    const attributes = scrubbedAttributes({ 'url.path': `/products/${run}`, 'user_agent.original': `${run}@${run}` });

    expect(performance.now() - started).toBeLessThan(150);
    expect(attributes['url.path']).toBe(`/products/${run}`);
  });

  it('scrubs event and link attributes by the same rules', () => {
    const { scrubbed } = recorded((tracer) => {
      const linked = tracer.startSpan('linked');
      linked.end();
      const span = tracer.startSpan('op', {
        links: [{ context: linked.spanContext(), attributes: { 'user.email': 'buyer@example.com', note: 'kept' } }],
      });
      span.addEvent('retry', {
        'http.request.header.authorization': 'Bearer abc',
        'url.full': 'https://x.test/a?token=1',
      });
      return span;
    });

    expect(scrubbed.links[0].attributes).toEqual({ note: 'kept' });
    expect(scrubbed.events[0]).toMatchObject({ name: 'retry', attributes: { 'url.full': 'https://x.test/a' } });
  });

  // The OTLP transformer calls spanContext(); a spread copy of a span would have lost the method.
  it("leaves a clean span's fields as they were, its context still a method", () => {
    const { raw, scrubbed } = recorded((tracer) => {
      const parent = tracer.startSpan('parent');
      const span = tracer.startSpan(
        'POST /orders',
        { attributes: { 'http.route': '/orders', 'http.status_code': 201, retried: false, tags: ['a', 'b'] } },
        trace.setSpan(context.active(), parent),
      );
      span.addEvent('reserved', { 'order.lines': 2 });
      span.setStatus({ code: SpanStatusCode.OK });
      parent.end();
      return span;
    });

    expect(scrubbed.parentSpanContext?.spanId).toBeDefined();
    expect(fieldsOf(scrubbed)).toEqual(fieldsOf(raw));
  });

  it("hands the inner exporter's result back unchanged", () => {
    const failed: ExportResult = { code: ExportResultCode.FAILED, error: new Error('Unauthorized') };
    const inner: SpanExporter = {
      export: (_spans, done) => done(failed),
      shutdown: () => Promise.resolve(),
    };
    const done = vi.fn();

    new ScrubbingSpanExporter(inner).export([recorded((tracer) => tracer.startSpan('op')).raw], done);

    expect(done).toHaveBeenCalledWith(failed);
  });

  // A throw would leave the batch processor waiting on a callback that never comes.
  it('fails the export of a span it cannot copy instead of throwing', () => {
    const inner = { export: vi.fn(), shutdown: () => Promise.resolve() };
    const done = vi.fn<(result: ExportResult) => void>();

    expect(() => new ScrubbingSpanExporter(inner).export([{ name: 'op' } as ReadableSpan], done)).not.toThrow();

    expect(inner.export).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledOnce();
    expect(done.mock.calls[0][0].code).toBe(ExportResultCode.FAILED);
    expect(done.mock.calls[0][0].error).toBeInstanceOf(TypeError);
  });

  it('delegates shutdown and forceFlush', async () => {
    const inner = {
      export: vi.fn(),
      shutdown: vi.fn(() => Promise.resolve()),
      forceFlush: vi.fn(() => Promise.resolve()),
    };
    const exporter = new ScrubbingSpanExporter(inner);

    await exporter.forceFlush();
    await exporter.shutdown();

    expect(inner.forceFlush).toHaveBeenCalledOnce();
    expect(inner.shutdown).toHaveBeenCalledOnce();
    await expect(
      new ScrubbingSpanExporter({ export: vi.fn(), shutdown: () => Promise.resolve() }).forceFlush(),
    ).resolves.toBeUndefined();
  });
});
