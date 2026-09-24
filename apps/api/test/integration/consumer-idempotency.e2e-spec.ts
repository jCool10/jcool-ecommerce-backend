import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { DomainEventDispatcher } from '../../src/shared/messaging/handlers/domain-event.dispatcher';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';
import { DomainEventProcessor } from '../../src/shared/messaging/queue/domain-event.processor';
import { DOMAIN_EVENTS_CONSUMER } from '../../src/shared/messaging/queue/queue.constants';
import { spyOnEffect } from '../setup/dispatcher-effect.helper';
import { createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

const MESSAGE_ID = '0198f0d8-0000-7000-8000-000000000001';
const ORDER_ID = '0198f0d8-1111-7000-8000-000000000001';

// Deliveries are driven by hand; the queue worker is off in e2e.
describe('Idempotent consumer (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let processor: DomainEventProcessor;
  let dispatcher: DomainEventDispatcher;
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

  const inboxRows = () => db.select().from(schema.inbox);

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
    processor = app.get(DomainEventProcessor);
    dispatcher = app.get(DomainEventDispatcher);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies an event once and records the claim under its consumer group', async () => {
    const effect = spyOnEffect(dispatcher);

    await expect(processor.process(job())).resolves.toBe('processed');

    expect(effect).toHaveBeenCalledTimes(1);
    const rows = await inboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      consumer: DOMAIN_EVENTS_CONSUMER,
      messageId: MESSAGE_ID,
      eventType: 'order.placed',
    });
  });

  it('collapses a redelivery of the same message into a single effect', async () => {
    const effect = spyOnEffect(dispatcher);

    await expect(processor.process(job())).resolves.toBe('processed');
    await expect(processor.process(job())).resolves.toBe('duplicate');

    expect(effect).toHaveBeenCalledTimes(1);
    expect(await inboxRows()).toHaveLength(1);
  });

  // A BullMQ republish carries the same outbox id under a new delivery.
  it('dedups on the outbox id, not on anything per delivery', async () => {
    const effect = spyOnEffect(dispatcher);

    await processor.process(job());
    await expect(
      processor.process(job({ traceparent: '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01' })),
    ).resolves.toBe('duplicate');

    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('rolls the claim back when the effect fails, so the redelivery does the work', async () => {
    const effect = spyOnEffect(dispatcher).mockRejectedValueOnce(new Error('handler exploded'));

    await expect(processor.process(job())).rejects.toThrow('handler exploded');

    expect(await inboxRows()).toHaveLength(0);

    effect.mockRestore();
    await expect(processor.process(job())).resolves.toBe('processed');
    expect(await inboxRows()).toHaveLength(1);
  });

  it('applies each of the order events the producers emit today', async () => {
    // order.paid resolves the buyer's address from `userId`, as the producers emit it.
    const { user } = await createTestPrincipal(app);
    const payload = { orderId: ORDER_ID, userId: user.id, totalAmountMinor: 150_000 };
    for (const [index, eventType] of ['order.placed', 'order.paid', 'order.failed', 'order.expired'].entries()) {
      const outboxId = `0198f0d8-0000-7000-8000-00000000000${index + 1}`;
      await expect(processor.process(job({ outboxId, eventType, payload }))).resolves.toBe('processed');
    }

    expect((await inboxRows()).map((row) => row.eventType).sort()).toEqual([
      'order.expired',
      'order.failed',
      'order.paid',
      'order.placed',
    ]);
  });

  it('fails an event with no handler and leaves it unclaimed', async () => {
    await expect(processor.process(job({ eventType: 'payment.refunded' }))).rejects.toThrow(/No handler registered/);

    expect(await inboxRows()).toHaveLength(0);
  });
});
