import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ExportResult, ExportResultCode } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
}

/** Answers like an OTLP/HTTP collector and keeps every body it was sent. */
export async function otlpCollector() {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      bodies.push(raw);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`,
    bodies: () => [...bodies],
    spans: (): OtlpSpan[] =>
      bodies.flatMap((body) => {
        const request = JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] };
        return request.resourceSpans.flatMap(({ scopeSpans }) => scopeSpans.flatMap(({ spans }) => spans));
      }),
    close: () => new Promise<void>((closed) => server.close(() => closed())),
  };
}

export type OtlpCollector = Awaited<ReturnType<typeof otlpCollector>>;

/** Sends `spans` to the collector through the production OTLP serializer, in one request. */
export async function exportOverOtlp(collector: OtlpCollector, spans: ReadableSpan[]): Promise<void> {
  const exporter = new OTLPTraceExporter({ url: collector.url });
  try {
    const result = await new Promise<ExportResult>((done) => exporter.export(spans, done));
    if (result.code !== ExportResultCode.SUCCESS) throw result.error ?? new Error('OTLP export failed');
  } finally {
    await exporter.shutdown();
  }
}
