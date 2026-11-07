import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import { type ExportResult, ExportResultCode } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';
import { ScrubbingSpanExporter } from '@jcool/platform/telemetry';

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

/** Answers like an OTLP/HTTP backend with `status` and keeps every request it got. */
async function backend(status = 200) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(status, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`,
    received,
    close: () => new Promise<void>((closed) => server.close(() => closed())),
  };
}

const exported = (exporter: SpanExporter, spans: ReadableSpan[]): Promise<ExportResult> =>
  new Promise((done) => exporter.export(spans, done));

/** Strings anywhere in a decoded body, so an escaped quote cannot hide a match. */
const stringsIn = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : value && typeof value === 'object'
      ? Object.values(value).flatMap(stringsIn)
      : [];

function finishedSpans(build: (provider: BasicTracerProvider) => void): ReadableSpan[] {
  const memory = new InMemorySpanExporter();
  build(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] }));
  return memory.getFinishedSpans();
}

const HEADERS_ENV = 'OTEL_EXPORTER_OTLP_HEADERS';
const previousHeaders = process.env[HEADERS_ENV];

afterEach(() => {
  if (previousHeaders === undefined) delete process.env[HEADERS_ENV];
  else process.env[HEADERS_ENV] = previousHeaders;
});

// The preloads build the exporter with a url of their own; production's credential comes only from
// the environment, so both have to reach the wire together.
describe('OTLP trace export', () => {
  it("sends the environment's headers to the url given in code", async () => {
    process.env[HEADERS_ENV] = 'Authorization=Basic%20dGVzdA==';
    const server = await backend();
    const exporter = new OTLPTraceExporter({ url: server.url });
    try {
      const spans = finishedSpans((provider) => provider.getTracer('spec').startSpan('op').end());

      expect(await exported(exporter, spans)).toMatchObject({ code: ExportResultCode.SUCCESS });
      expect(server.received[0].headers.authorization).toBe('Basic dGVzdA==');
    } finally {
      await exporter.shutdown();
      await server.close();
    }
  });

  it('exports no personal data, query string or request body text', async () => {
    const server = await backend();
    const exporter = new ScrubbingSpanExporter(new OTLPTraceExporter({ url: server.url }));
    try {
      const spans = finishedSpans((provider) => {
        const tracer = provider.getTracer('spec');
        const parent = tracer.startSpan('POST /auth/login');
        const span = tracer.startSpan(
          'middleware - jsonParser',
          {
            attributes: {
              'user.email': 'buyer@example.com',
              'url.full': 'https://shop.test/auth/verify-email?token=abc',
            },
          },
          trace.setSpan(context.active(), parent),
        );
        span.recordException(new Error('no account for buyer@example.com'));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `Unexpected token 'p', "password=hunter2" is not valid JSON`,
        });
        span.end();
        parent.end();
      });

      expect(await exported(exporter, spans)).toMatchObject({ code: ExportResultCode.SUCCESS });
      const sent = stringsIn(JSON.parse(server.received[0].body));
      for (const forbidden of ['buyer@example.com', 'token=abc', 'hunter2', 'password=']) {
        expect(
          sent.filter((text) => text.includes(forbidden)),
          forbidden,
        ).toEqual([]);
      }
      const [child, parent] = spans;
      expect(sent).toEqual(
        expect.arrayContaining([child.spanContext().traceId, child.spanContext().spanId, parent.spanContext().spanId]),
      );
    } finally {
      await exporter.shutdown();
      await server.close();
    }
  });

  it('reports a rejecting backend as a failed export instead of throwing', async () => {
    const server = await backend(401);
    const exporter = new ScrubbingSpanExporter(new OTLPTraceExporter({ url: server.url }));
    try {
      const spans = finishedSpans((provider) => provider.getTracer('spec').startSpan('op').end());

      expect(await exported(exporter, spans)).toMatchObject({ code: ExportResultCode.FAILED });
    } finally {
      await exporter.shutdown();
      await server.close();
    }
  });
});
