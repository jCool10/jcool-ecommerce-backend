import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ORDER_EVENTS_CONSUMER, ORDER_EVENTS_QUEUE } from '@jcool/internal-contracts/queues/order-events';
import { type DomainEventJob, DomainEventProcessor } from '@jcool/messaging';
import type { DrizzleDB } from '../../src/database';
import * as schema from '../../src/database/schema';
import { OrderEventsDispatcher } from '../../src/shared/messaging/order-events.handlers';
import { spyOnEffect } from '../setup/dispatcher-effect.helper';
import { createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

const MESSAGE_ID = testId();
const ORDER_ID = testId();

// Deliveries are driven by hand; the queue worker is off in e2e.
describe('Idempotent consumer (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let processor: DomainEventProcessor;
  let dispatcher: OrderEventsDispatcher;
  let db: DrizzleDB;
  let pool: Pool;

  const job = (overrides: Partial<DomainEventJob> = {}): DomainEventJob => ({
    outboxId: MESSAGE_ID,
    aggregateType: 'Order',
    aggregateId: ORDER_ID,
    eventType: 'order.placed',
    payload: { orderId: ORDER_ID, totalAmountMinor: 150_000 },
    occurredAt: '2026-08-24T00:00:00.000Z',
    traceparent: null,
    ...overrides,
  });

  const deliver = (event: DomainEventJob, queue = ORDER_EVENTS_QUEUE) => processor.process(event, queue);

  const inboxRows = () => db.select().from(schema.inbox);

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
    processor = app.get(DomainEventProcessor);
    dispatcher = app.get(OrderEventsDispatcher);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies an event once and records the claim under its consumer group', async () => {
    const effect = spyOnEffect(dispatcher);

    await expect(deliver(job())).resolves.toBe('processed');

    expect(effect).toHaveBeenCalledTimes(1);
    const rows = await inboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      consumer: ORDER_EVENTS_CONSUMER,
      messageId: MESSAGE_ID,
      eventType: 'order.placed',
    });
  });

  it('collapses a redelivery of the same message into a single effect', async () => {
    const effect = spyOnEffect(dispatcher);

    await expect(deliver(job())).resolves.toBe('processed');
    await expect(deliver(job())).resolves.toBe('duplicate');

    expect(effect).toHaveBeenCalledTimes(1);
    expect(await inboxRows()).toHaveLength(1);
  });

  // A BullMQ republish carries the same outbox id under a new delivery.
  it('dedups on the outbox id, not on anything per delivery', async () => {
    const effect = spyOnEffect(dispatcher);

    await deliver(job());
    await expect(deliver(job({ traceparent: '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01' }))).resolves.toBe(
      'duplicate',
    );

    expect(effect).toHaveBeenCalledTimes(1);
  });

  // api-events stays with the api; a job routed here by mistake must not be claimed under any group.
  it('refuses a delivery on a queue this service does not consume', async () => {
    await expect(deliver(job(), 'api-events')).rejects.toThrow('queue api-events has no consumer in this process');

    expect(await inboxRows()).toHaveLength(0);
  });

  it('rolls the claim back when the effect fails, so the redelivery does the work', async () => {
    const effect = spyOnEffect(dispatcher).mockRejectedValueOnce(new Error('handler exploded'));

    await expect(deliver(job())).rejects.toThrow('handler exploded');

    expect(await inboxRows()).toHaveLength(0);

    effect.mockRestore();
    await expect(deliver(job())).resolves.toBe('processed');
    expect(await inboxRows()).toHaveLength(1);
  });

  it('applies each of the order events the producers emit today', async () => {
    // order.paid resolves the buyer's address from `userId`, as the producers emit it.
    const { user } = await createTestPrincipal(app);
    const payload = { orderId: ORDER_ID, userId: user.id, totalAmountMinor: 150_000 };
    for (const eventType of ['order.placed', 'order.paid', 'order.failed', 'order.expired', 'order.cancelled']) {
      await expect(deliver(job({ outboxId: testId(), eventType, payload }))).resolves.toBe('processed');
    }

    expect((await inboxRows()).map((row) => row.eventType).sort()).toEqual([
      'order.cancelled',
      'order.expired',
      'order.failed',
      'order.paid',
      'order.placed',
    ]);
  });

  it('fails an event with no handler and leaves it unclaimed', async () => {
    await expect(deliver(job({ eventType: 'payment.refunded' }))).rejects.toThrow(/No handler registered/);

    expect(await inboxRows()).toHaveLength(0);
  });
});
