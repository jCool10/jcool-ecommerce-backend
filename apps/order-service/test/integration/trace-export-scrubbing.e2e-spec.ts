import { spanExporter } from '../setup/tracing-preload';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { SpanKind } from '@opentelemetry/api';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAppAfterAll } from '../setup/harness';
import { exportOverOtlp, otlpCollector } from '../setup/otlp-collector';
import { createTestApp } from '../setup/test-app.factory';

// V8 quotes the bytes around the fault of an unexpected token, so the password lands in the message.
const MALFORMED_LOGIN = '{"email":"buyer@example.com","password":hunter2}';

const stringsIn = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : value && typeof value === 'object'
      ? Object.values(value).flatMap(stringsIn)
      : [];

// Body parsing runs before routing, so every exporting route shares the exposure of the login's.
describe('Trace export scrubbing (integration, OpenTelemetry SDK in process)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  closeAppAfterAll(() => app);
  beforeEach(() => spanExporter.reset());

  it('a malformed JSON body leaves no fragment of itself in the exported spans', async () => {
    const traceId = randomBytes(16).toString('hex');

    await request(app.getHttpServer())
      .post('/orders')
      .set('content-type', 'application/json')
      .set('traceparent', `00-${traceId}-${randomBytes(8).toString('hex')}-01`)
      .send(MALFORMED_LOGIN)
      .expect(400);

    const spans = spanExporter.getFinishedSpans().filter((span) => span.spanContext().traceId === traceId);
    expect(spans.filter((span) => span.kind === SpanKind.SERVER)).toHaveLength(1);
    // The layer that failed is body-parser's: without a span of its own, nothing records the error.
    expect(spans.map((span) => span.name).filter((name) => name.startsWith('middleware'))).toEqual([]);

    const collector = await otlpCollector();
    try {
      await exportOverOtlp(collector, spans);
      const sent = collector.bodies().flatMap((body) => stringsIn(JSON.parse(body)));

      expect(sent).toContain(traceId);
      for (const fragment of ['hunter2', 'buyer@example.com', '"password']) {
        expect(
          sent.filter((text) => text.includes(fragment)),
          fragment,
        ).toEqual([]);
      }
    } finally {
      await collector.close();
    }
  });
});
