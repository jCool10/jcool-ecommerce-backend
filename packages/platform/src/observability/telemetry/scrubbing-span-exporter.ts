import type { Attributes, AttributeValue } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { JSON_PARSE_ERROR, MALFORMED_BODY_REASON } from '../logging/json-parse-error';
import { SENSITIVE_KEYS } from '../logging/sensitive-keys';

const REDACTED = '[redacted]';

// Header attributes spell a name with dashes or underscores, depending on the semconv in use.
const compact = (name: string): string => name.toLowerCase().replace(/[-_]/g, '');

const CREDENTIAL_SEGMENTS = new Set([...SENSITIVE_KEYS, 'idempotency-key'].map(compact));

const DROPPED_KEYS = new Set(['client.address', 'http.client_ip', 'user.email', 'enduser.id', 'db.user', 'url.query']);

// Mail links carry their token in the query.
const URL_KEYS = new Set(['url.full', 'http.url', 'http.target']);

// Bounded to an address's length limits: unbounded, every start in a long run of letters would scan
// to its end, and clients choose the request path and user agent.
const SECRET_TEXT = new RegExp(
  [
    String.raw`[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}`,
    String.raw`\b[sr]k_(?:live|test)_[A-Za-z0-9]+`,
    String.raw`\bwhsec_[A-Za-z0-9]+`,
    String.raw`\bpi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+`,
  ].join('|'),
  'g',
);

const isDroppedKey = (key: string): boolean =>
  DROPPED_KEYS.has(key) || key.split('.').some((segment) => CREDENTIAL_SEGMENTS.has(compact(segment)));

const scrubText = (text: string): string =>
  JSON_PARSE_ERROR.test(text) ? MALFORMED_BODY_REASON : text.replace(SECRET_TEXT, REDACTED);

function scrubValue(key: string, value: AttributeValue): AttributeValue {
  if (typeof value === 'string') return scrubText(URL_KEYS.has(key) ? value.split('?', 1)[0] : value);
  if (!Array.isArray(value)) return value;
  return value.map((item) => (typeof item === 'string' ? scrubText(item) : item)) as AttributeValue;
}

function scrubAttributes(attributes: Attributes): Attributes {
  const scrubbed: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || isDroppedKey(key)) continue;
    scrubbed[key] = scrubValue(key, value);
  }
  return scrubbed;
}

/** A copy of `span` safe to hand to a third-party backend. */
export function scrubSpan(span: ReadableSpan): ReadableSpan {
  return {
    name: span.name,
    kind: span.kind,
    // A method on the SDK's span, so a spread would drop it and the OTLP serializer would throw.
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    ended: span.ended,
    status:
      span.status.message === undefined ? span.status : { ...span.status, message: scrubText(span.status.message) },
    attributes: scrubAttributes(span.attributes),
    links: span.links.map((link) =>
      link.attributes ? { ...link, attributes: scrubAttributes(link.attributes) } : link,
    ),
    events: span.events.map((event) =>
      event.attributes ? { ...event, attributes: scrubAttributes(event.attributes) } : event,
    ),
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/**
 * Wraps the exporter that leaves the process, so every span is scrubbed on its way out, the
 * Temporal workflow spans the worker hands over through its sink included.
 */
export class ScrubbingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    let scrubbed: ReadableSpan[];
    try {
      scrubbed = spans.map(scrubSpan);
    } catch (error) {
      // ExportResultCode.FAILED; `@opentelemetry/core` is a type-only peer here.
      resultCallback({ code: 1, error: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    this.inner.export(scrubbed, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
