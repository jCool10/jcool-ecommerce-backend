import type { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Pool } from 'pg';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SagaKickExecutor } from '../../src/modules/order/application/saga/saga-kick.executor';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { DomainEventDispatcher } from '../../src/shared/messaging/handlers/domain-event.dispatcher';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';
import { DomainEventProcessor } from '../../src/shared/messaging/queue/domain-event.processor';
import { DOMAIN_EVENTS_CONSUMER, DOMAIN_EVENTS_QUEUE } from '../../src/shared/messaging/queue/queue.constants';
import { spyOnEffect } from '../setup/dispatcher-effect.helper';
import {
  placeAndOpenSession,
  postWebhook,
  readOrder,
  readSaga,
  seedSellableSku,
} from '../setup/fixtures/order-flow.fixture';
import { createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithFakeGateway, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { checkoutSessionCompleted, signWebhookAs } from '../setup/sign-webhook.helper';

const WEBHOOK_SECRET = 'whsec_e2e_consumer_idempotency_0123';
const MESSAGE_ID = testId();
const ORDER_ID = testId();

// Deliveries are driven by hand; the queue worker is off in e2e.
describe('Idempotent consumer (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let processor: DomainEventProcessor;
  let dispatcher: DomainEventDispatcher;
  let db: DrizzleDB;
  let pool: Pool;
  let gateway: FakeSignerGatewayAdapter;

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
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
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
    for (const eventType of ['order.placed', 'order.paid', 'order.failed', 'order.expired', 'order.cancelled']) {
      await expect(processor.process(job({ outboxId: testId(), eventType, payload }))).resolves.toBe('processed');
    }

    expect((await inboxRows()).map((row) => row.eventType).sort()).toEqual([
      'order.cancelled',
      'order.expired',
      'order.failed',
      'order.paid',
      'order.placed',
    ]);
  });

  // The capture the saga runs is the one effect a redelivered authorization must never repeat.
  it('moves the saga once for an authorization delivered twice', async () => {
    const order = await placeAndOpenSession(app, await seedSellableSku(app, { onHand: 5 }));
    const intentId = gateway.authorize(order.sessionId);
    const completed = checkoutSessionCompleted(order.sessionId, { ...order.charge, paymentStatus: 'unpaid' });
    await postWebhook(app, signWebhookAs(gateway, completed)).expect(200);
    await app.get(OutboxRelay).runOnce(10);
    const queued = await app.get<Queue<DomainEventJob>>(DOMAIN_EVENTS_QUEUE).getJobs(['waiting']);
    const authorized = queued.map(({ data }) => data).find(({ eventType }) => eventType === 'payment.authorized');
    if (!authorized) throw new Error('payment.authorized was never relayed');

    await expect(processor.process(authorized)).resolves.toBe('processed');
    await expect(processor.process(authorized)).resolves.toBe('duplicate');
    await app.get(SagaKickExecutor).drain();

    expect((await readOrder(app, order.orderId)).status).toBe('PAID');
    expect((await readSaga(app, order.orderId)).step).toBe('COMPLETED');
    expect(gateway.captureCalls(intentId)).toBe(1);
    await Promise.all(queued.map((queuedJob) => queuedJob.remove()));
  });

  it('fails an event with no handler and leaves it unclaimed', async () => {
    await expect(processor.process(job({ eventType: 'payment.refunded' }))).rejects.toThrow(/No handler registered/);

    expect(await inboxRows()).toHaveLength(0);
  });
});
