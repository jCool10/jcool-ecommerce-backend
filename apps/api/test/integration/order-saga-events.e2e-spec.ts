import type { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinalizeOrderUseCase } from '../../src/modules/order/application/use-cases';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { DomainEventDispatcher } from '../../src/shared/messaging/handlers/domain-event.dispatcher';
import { METRICS, type MetricsPort } from '../../src/shared/observability/metrics/metrics.port';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';
import { DomainEventProcessor } from '../../src/shared/messaging/queue/domain-event.processor';
import { DOMAIN_EVENTS_QUEUE } from '../../src/shared/messaging/queue/queue.constants';
import {
  auditLedgerInvariants,
  placeAndOpenSession,
  postWebhook,
  readOrder,
  readReservation,
  readStock,
  seedSellableSku,
  signOutcome,
  type OpenOrder,
  type SellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway } from '../setup/harness';
import { resetDatabase } from '../setup/reset-database';

const WEBHOOK_SECRET = 'whsec_e2e_saga_events_0123456789';
const ON_HAND = 5;
const QUANTITY = 2;

/**
 * Order settles itself from Payment's event instead of from an in-process call a crash can swallow.
 * The webhook still finalizes directly for latency, so most assertions here are about the event
 * reaching an ALREADY settled order and costing nothing — and about the case where it is all there is.
 */
describe('Payment settlement events → order saga (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let relay: OutboxRelay;
  let processor: DomainEventProcessor;
  let dispatcher: DomainEventDispatcher;
  let queue: Queue;
  let finalize: FinalizeOrderUseCase;
  let sku: SellableSku;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
    relay = app.get(OutboxRelay);
    processor = app.get(DomainEventProcessor);
    dispatcher = app.get(DomainEventDispatcher);
    queue = app.get<Queue>(DOMAIN_EVENTS_QUEUE);
    finalize = app.get(FinalizeOrderUseCase);
  });
  closeAppAfterAll(() => app);

  // Explicit rather than `resetDatabaseBeforeEach`: the queue has to be emptied in the same hook and
  // after the truncate, or a job left over from the previous test lands on rows that no longer exist.
  beforeEach(async () => {
    await resetDatabase(pool);
    await queue.obliterate({ force: true });
    sku = await seedSellableSku(app, { onHand: ON_HAND });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const outboxRows = (eventType: string) =>
    db.select().from(schema.outbox).where(eq(schema.outbox.eventType, eventType));

  const inboxRows = () => db.select().from(schema.inbox);

  /** The envelope the worker would receive, taken off the real queue rather than hand-built. */
  const publishedJobs = async (): Promise<DomainEventJob[]> => {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);
    return jobs.map((job) => job.data as DomainEventJob);
  };

  const deliverAll = async (): Promise<string[]> => {
    const results: string[] = [];
    for (const job of await publishedJobs()) {
      results.push(await processor.process(job));
    }
    return results;
  };

  const settle = (order: OpenOrder, outcome: 'PAID' | 'FAILED', eventId: string) =>
    postWebhook(app, signOutcome(WEBHOOK_SECRET, order.sessionId, order.charge, outcome, eventId));

  it.each([
    ['PAID', 'payment.succeeded'],
    ['FAILED', 'payment.failed'],
  ] as const)('emits %s as %s, in the transaction that settled the payment', async (outcome, eventType) => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);

    await settle(order, outcome, `evt_emit_${outcome}`).expect(200);

    const [emitted] = await outboxRows(eventType);
    // The payment row is the aggregate; the order it belongs to travels in the payload, so the
    // consumer never has to read Payment's tables to know what to settle.
    expect(emitted).toMatchObject({ aggregateType: 'Payment', publishedAt: null });
    expect(emitted.payload).toMatchObject({ orderId: order.orderId });
  });

  it('emits nothing for a delivery that settles no payment, so no order is driven off a non-event', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    const delivery = signOutcome(WEBHOOK_SECRET, order.sessionId, order.charge, 'PAID', 'evt_dup');

    await postWebhook(app, delivery).expect(200);
    await postWebhook(app, delivery).expect(200);

    expect(await outboxRows('payment.succeeded')).toHaveLength(1);
  });

  // The reason the event exists at all.
  it('settles the order from the event alone when the in-process finalize is lost', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    const killed = vi
      .spyOn(finalize, 'execute')
      .mockRejectedValueOnce(new Error('process died between the payment and the order'));

    await settle(order, 'PAID', 'evt_crash').expect(200);
    killed.mockRestore();

    // Money moved, order did not: the exact state a crash between the two transactions leaves.
    expect((await readOrder(app, order.orderId)).status).toBe('PENDING');
    expect((await readReservation(app, order.orderId)).status).toBe('HELD');

    await relay.runOnce(10);
    expect(await deliverAll()).toContain('processed');

    expect((await readOrder(app, order.orderId)).status).toBe('PAID');
    expect((await readReservation(app, order.orderId)).status).toBe('COMMITTED');
    const stock = await readStock(app, sku.variantId);
    expect(stock.quantityOnHand).toBe(ON_HAND - QUANTITY);
    expect(stock.quantityReserved).toBe(0);

    const audit = await auditLedgerInvariants(app, { [sku.variantId]: ON_HAND });
    expect(audit).toMatchObject({ orders: 1, pending: [], violations: [] });
  });

  it('costs nothing when it reaches an order the webhook already settled', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    await settle(order, 'PAID', 'evt_already').expect(200);

    await relay.runOnce(10);
    await deliverAll();

    expect((await readOrder(app, order.orderId)).status).toBe('PAID');
    const stock = await readStock(app, sku.variantId);
    expect(stock.quantityOnHand).toBe(ON_HAND - QUANTITY);
    expect(stock.quantityReserved).toBe(0);
    // Re-committing the hold would have moved on-hand a second time; the terminal guard is what
    // makes the direct call and the event add up to one effect rather than two.
    expect((await readReservation(app, order.orderId)).status).toBe('COMMITTED');
  });

  it('collapses a redelivered settlement into one effect', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    await settle(order, 'PAID', 'evt_redeliver').expect(200);
    await relay.runOnce(10);
    const [settlement] = (await publishedJobs()).filter((job) => job.eventType === 'payment.succeeded');

    await expect(processor.process(settlement)).resolves.toBe('processed');
    await expect(processor.process(settlement)).resolves.toBe('duplicate');

    expect((await inboxRows()).filter((row) => row.eventType === 'payment.succeeded')).toHaveLength(1);
  });

  it('does not un-commit a paid order when a failure event is delivered late', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    await settle(order, 'PAID', 'evt_ordered_paid').expect(200);
    await relay.runOnce(10);
    await deliverAll();

    // A settlement Payment refused (its own state machine rejects SUCCEEDED→FAILED), replayed here
    // straight at the consumer: out-of-order delivery is the transport's to produce, not Payment's.
    const late: DomainEventJob = {
      outboxId: '0198f0d8-9999-7000-8000-000000000001',
      aggregateType: 'Payment',
      aggregateId: '0198f0d8-8888-7000-8000-000000000001',
      eventType: 'payment.failed',
      payload: { orderId: order.orderId, paymentRef: null },
      occurredAt: new Date().toISOString(),
      traceparent: null,
    };

    await expect(processor.process(late)).resolves.toBe('processed');

    expect((await readOrder(app, order.orderId)).status).toBe('PAID');
    expect((await readReservation(app, order.orderId)).status).toBe('COMMITTED');
    expect((await readStock(app, sku.variantId)).quantityOnHand).toBe(ON_HAND - QUANTITY);
  });

  it('acknowledges a settlement whose order does not exist, and books the refund it now owes', async () => {
    // The refund signal is the point, not a detail: money moved at the gateway and there is no order
    // to ship, so acknowledging the job silently would retire the event with nothing recording that
    // someone is owed a refund. `order-cancel.e2e-spec.ts` covers the sibling `ignored` branch;
    // this is the only assertion on the `not_found` one.
    const refundOwed = vi.spyOn(app.get<MetricsPort>(METRICS), 'recordRefundOwed');

    const orphan: DomainEventJob = {
      outboxId: '0198f0d8-9999-7000-8000-000000000002',
      aggregateType: 'Payment',
      aggregateId: '0198f0d8-8888-7000-8000-000000000002',
      eventType: 'payment.succeeded',
      payload: { orderId: '0198f0d8-7777-7000-8000-000000000002', paymentRef: 'pi_orphan' },
      occurredAt: new Date().toISOString(),
      traceparent: null,
    };

    await expect(processor.process(orphan)).resolves.toBe('processed');
    expect(refundOwed).toHaveBeenCalledWith('settlement_event');
  });

  it('sends a settlement it cannot read straight to the dead-letter path, without retrying', async () => {
    const malformed: DomainEventJob = {
      outboxId: '0198f0d8-9999-7000-8000-000000000003',
      aggregateType: 'Payment',
      aggregateId: '0198f0d8-8888-7000-8000-000000000003',
      eventType: 'payment.succeeded',
      payload: { paymentRef: 'pi_no_order' },
      occurredAt: new Date().toISOString(),
      traceparent: null,
    };

    await expect(processor.process(malformed)).rejects.toThrow(/Unusable payment settlement event/);
    expect(await inboxRows()).toHaveLength(0);
  });

  // The invariant the whole consumer design rests on, asserted where it can actually break: the
  // settlement is a multi-row write in another context, and it has to live or die with the claim.
  it('leaves neither the settlement nor the claim when the worker dies after applying the effect', async () => {
    const order = await placeAndOpenSession(app, sku, QUANTITY);
    const lost = vi.spyOn(finalize, 'execute').mockRejectedValueOnce(new Error('killed before the order settled'));
    await settle(order, 'PAID', 'evt_atomic').expect(200);
    lost.mockRestore();
    await relay.runOnce(10);
    const [settlement] = (await publishedJobs()).filter((job) => job.eventType === 'payment.succeeded');

    // Asserted because `strictBindCallApply` is off, so `bind` alone would hand back `any`.
    const applyEffect = dispatcher.dispatch.bind(dispatcher) as DomainEventDispatcher['dispatch'];
    const applyThenDie = vi.spyOn(dispatcher, 'dispatch').mockImplementation(async (job, tx) => {
      await applyEffect(job, tx);
      throw new Error('worker died after the effect');
    });

    await expect(processor.process(settlement)).rejects.toThrow('worker died after the effect');

    applyThenDie.mockRestore();
    expect((await readOrder(app, order.orderId)).status).toBe('PENDING');
    expect(await inboxRows()).toHaveLength(0);

    await expect(processor.process(settlement)).resolves.toBe('processed');
    expect((await readOrder(app, order.orderId)).status).toBe('PAID');
  });
});
