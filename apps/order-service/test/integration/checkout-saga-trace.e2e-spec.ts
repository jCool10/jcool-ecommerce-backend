import { spanExporter } from '../setup/tracing-preload';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { SpanKind, trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authHeader } from '../setup/bearer.helper';
import { eventually } from '../setup/eventually';
import { relayAuthorization, sagaHandle } from '../setup/fixtures/checkout-saga.fixture';
import {
  authorizePayment,
  buyerWithCart,
  checkout,
  openSession,
  seedSellableSku,
  untilOrderStatus,
} from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetSagasAndDatabaseBeforeEach } from '../setup/harness';
import { type InventoryServiceStub, inventoryServiceStub } from '../setup/inventory-service-stub';
import { exportOverOtlp, otlpCollector } from '../setup/otlp-collector';
import { type PaymentServiceStub, paymentServiceStub } from '../setup/payment-service-stub';

const newTraceId = (): string => randomBytes(16).toString('hex');
const traceparentOf = (traceId: string, sampled = true): string =>
  `00-${traceId}-${randomBytes(8).toString('hex')}-${sampled ? '01' : '00'}`;
const parse = (traceparent: string | null | undefined) => {
  const [, traceId, spanId, flags] = (traceparent ?? '').split('-');
  return { traceId, spanId, flags };
};

const spansIn = (traceId: string): ReadableSpan[] =>
  spanExporter.getFinishedSpans().filter((span) => span.spanContext().traceId === traceId);
const named = (spans: ReadableSpan[], name: string): ReadableSpan | undefined =>
  spans.find((span) => span.name === name);

/** Workflow spans cross the sandbox through a sink after their activation, so they land a little late. */
const untilSpansIn = async (traceId: string, names: string[]): Promise<ReadableSpan[]> => {
  await eventually(
    () => spansIn(traceId).map((span) => span.name),
    (seen) => names.every((name) => seen.includes(name)),
    10_000,
  );
  return spansIn(traceId);
};

/** The span the received traceparent names as its parent: the caller's client span, if it was recorded. */
const senderOf = (traceparent: string | null | undefined): ReadableSpan | undefined => {
  const { traceId, spanId } = parse(traceparent);
  return spansIn(traceId).find((span) => span.spanContext().spanId === spanId);
};
const parentOf = (span: ReadableSpan): ReadableSpan | undefined =>
  spansIn(span.spanContext().traceId).find(
    (candidate) => candidate.spanContext().spanId === span.parentSpanContext?.spanId,
  );
/** Nearest first, up to the first parent not recorded (or still open). */
const ancestorsOf = (span: ReadableSpan | undefined): ReadableSpan[] => {
  const chain: ReadableSpan[] = [];
  for (let parent = span && parentOf(span); parent; parent = parentOf(parent)) chain.push(parent);
  return chain;
};

describe('Checkout saga trace (integration, real Temporal, OpenTelemetry SDK in process)', () => {
  let app: INestApplication;
  let pool: Pool;
  let inventory: InventoryServiceStub;
  let payment: PaymentServiceStub;

  beforeAll(async () => {
    inventory = await inventoryServiceStub();
    payment = await paymentServiceStub();
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app],
    () => pool,
  );
  beforeEach(() => spanExporter.reset());

  const placeOrder = async (traceparent: string): Promise<{ token: string; orderId: string }> => {
    const sku = await seedSellableSku(app, { onHand: 5 });
    const token = await buyerWithCart(app, sku.variantId);
    const placed = await checkout(app, token).set('traceparent', traceparent).expect(201);
    return { token, orderId: placed.body.id as string };
  };

  const cancelAndClose = async (token: string, orderId: string): Promise<void> => {
    await request(app.getHttpServer()).post(`/orders/${orderId}/cancel`).set(authHeader(token)).expect(200);
    await sagaHandle(app, orderId).result();
  };

  // The reads right after a response, and the absence checks, assume nothing is still on its way.
  it('hands each span to the exporter as it ends', () => {
    trace.getTracer('harness').startSpan('probe').end();

    expect(spanExporter.getFinishedSpans().map((span) => span.name)).toContain('probe');
  });

  it('one trace runs from POST /orders through the workflow to the inventory call', async () => {
    const traceId = newTraceId();
    const { token, orderId } = await placeOrder(traceparentOf(traceId));

    // Guards the harness: without patched http there is no server span and nothing below can hold.
    expect(spansIn(traceId).filter((span) => span.kind === SpanKind.SERVER)).not.toEqual([]);

    await untilSpansIn(traceId, [
      'UpdateWithStartWorkflow:reserve',
      'HandleUpdate:reserve',
      'StartActivity:tryReserve',
      'RunActivity:tryReserve',
    ]);
    const [tryHeader] = inventory.traceparentsOf('try');
    expect(parse(tryHeader)).toMatchObject({ traceId, flags: '01' });
    const fetchSpan = senderOf(tryHeader);
    expect(fetchSpan?.kind).toBe(SpanKind.CLIENT);

    // One tree: the update handler runs the Try, so the inventory call hangs off it up to the request.
    const chain = ancestorsOf(fetchSpan);
    expect(chain.map((span) => span.name)).toEqual(
      expect.arrayContaining([
        'RunActivity:tryReserve',
        'StartActivity:tryReserve',
        'HandleUpdate:reserve',
        'UpdateWithStartWorkflow:reserve',
      ]),
    );
    expect(chain.at(-1)?.kind).toBe(SpanKind.SERVER);

    await cancelAndClose(token, orderId);
    const run = named(await untilSpansIn(traceId, ['RunWorkflow:CheckoutSaga']), 'RunWorkflow:CheckoutSaga');
    expect(run && parentOf(run)?.name).toBe('UpdateWithStartWorkflow:reserve');
  });

  it("the authorization's activities continue the trace the event carried", async () => {
    const placedIn = newTraceId();
    const { token, orderId } = await placeOrder(traceparentOf(placedIn));
    await openSession(app, token, orderId).expect(201);
    const authorizedIn = newTraceId();

    await authorizePayment(orderId, traceparentOf(authorizedIn));
    await relayAuthorization(app, orderId);
    await untilOrderStatus(app, orderId, 'PAID');

    const spans = await untilSpansIn(authorizedIn, [
      'consume:payment.authorized',
      'SignalWithStartWorkflow:CheckoutSaga',
      'HandleSignal:paymentAuthorized',
      'RunActivity:verifyAuthorization',
      'RunActivity:commitStock',
      'RunActivity:capturePayment',
    ]);
    // The signal handler starts the follow-up commands itself, so they run under its span, not the run's.
    expect(ancestorsOf(named(spans, 'RunActivity:capturePayment')).map((span) => span.name)).toEqual(
      expect.arrayContaining(['HandleSignal:paymentAuthorized', 'consume:payment.authorized']),
    );
    expect(parse(inventory.traceparentsOf('commit').at(-1))).toMatchObject({ traceId: authorizedIn });
    expect(parse(payment.traceparentsOf('capture').at(-1))).toMatchObject({ traceId: authorizedIn });

    await sagaHandle(app, orderId).result();
    await untilSpansIn(placedIn, ['RunWorkflow:CheckoutSaga']);
  });

  // A span the OTLP serializer cannot take fails its whole batch, HTTP spans included; workflow spans
  // carry the run's WorkflowInfo as attributes.
  it('exports the workflow spans as OTLP in one batch with the request they continue', async () => {
    const traceId = newTraceId();
    const { token, orderId } = await placeOrder(traceparentOf(traceId));
    await cancelAndClose(token, orderId);
    const spans = await untilSpansIn(traceId, ['RunWorkflow:CheckoutSaga', 'UpdateWithStartWorkflow:reserve']);
    const run = named(spans, 'RunWorkflow:CheckoutSaga')!;
    const server = spans.find((span) => span.kind === SpanKind.SERVER)!;
    await Promise.all([run.resource.waitForAsyncAttributes?.(), server.resource.waitForAsyncAttributes?.()]);
    expect(run.resource.attributes).toEqual(server.resource.attributes);
    expect(run.resource.attributes).toHaveProperty(['host.name']);

    const collector = await otlpCollector();
    try {
      await exportOverOtlp(collector, spans);
    } finally {
      await collector.close();
    }

    const exported = collector.spans();
    const start = exported.find((span) => span.name === 'UpdateWithStartWorkflow:reserve');
    expect(exported.find((span) => span.name === 'RunWorkflow:CheckoutSaga')).toMatchObject({
      traceId,
      parentSpanId: start?.spanId,
    });
    expect(exported.map((span) => span.name)).toContain('POST /orders');
  });

  it('an unsampled request passes its trace on and records no span of the saga', async () => {
    const traceId = newTraceId();
    const { token, orderId } = await placeOrder(traceparentOf(traceId, false));

    expect(parse(inventory.traceparentsOf('try').at(-1))).toMatchObject({ traceId, flags: '00' });
    await cancelAndClose(token, orderId);

    // The closed run's spans were handed to the sink before its result came back.
    expect(spansIn(traceId).map((span) => span.name)).toEqual([]);
  });
});
