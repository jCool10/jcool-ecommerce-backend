import type { INestApplication } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { ORDER_EVENTS_QUEUE } from '@jcool/internal-contracts/queues/order-events';
import { DomainEventProcessor } from '@jcool/messaging';
import { OUTBOX_WRITER, type OutboxRecord, type OutboxWriterPort } from '@jcool/messaging/outbox-port';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/bearer.helper';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { relayedAuthorizations } from '../setup/fixtures/checkout-saga.fixture';
import { readReservationOrder } from '../setup/fixtures/inventory.fixture';
import {
  authorizePayment,
  buyerWithCart,
  placeAndOpenSession,
  readStock,
  seedSellableSku,
  untilOrderStatus,
} from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetSagasAndDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

const STOCK = 5;
const PRICE = 150_000;

// An event is written by the same transaction as the business change it describes, so the two can
// never disagree. These tests assert the write side only: `published_at` stays NULL for the relay.
describe('Transactional outbox append (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app],
    () => pool,
  );

  const readOutbox = (orderId: string) =>
    db.select().from(schema.outbox).where(eq(schema.outbox.aggregateId, orderId)).orderBy(asc(schema.outbox.createdAt));

  it('appends exactly one unpublished order.placed row in the checkout transaction', async () => {
    const sku = await seedSellableSku(app, { onHand: STOCK, priceMinor: PRICE });
    const token = await buyerWithCart(app, sku.variantId, 2);

    const response = await request(app.getHttpServer())
      .post('/orders')
      .set(authHeader(token))
      .set(idempotencyKeyHeader())
      .expect(201);
    const orderId = response.body.id as string;

    const rows = await readOutbox(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      aggregateType: 'Order',
      aggregateId: orderId,
      eventType: 'order.placed',
      attempts: 0,
      // NULL is the relay's work queue: until it publishes, this row is the only durable record.
      publishedAt: null,
    });
    expect(rows[0].payload).toEqual({
      orderId,
      userId: expect.any(String),
      totalAmountMinor: PRICE * 2,
      currency: 'VND',
      placedAt: expect.any(String),
    });
    // Tracing is off in e2e, so there is no span to capture and the column stays null rather than
    // holding a malformed header.
    expect(rows[0].traceparent).toBeNull();
  });

  it('does not re-emit when a retried Idempotency-Key replays the same order', async () => {
    const sku = await seedSellableSku(app, { onHand: STOCK, priceMinor: PRICE });
    const token = await buyerWithCart(app, sku.variantId, 1);
    const key = idempotencyKeyHeader();

    const first = await request(app.getHttpServer()).post('/orders').set(authHeader(token)).set(key).expect(201);
    const replay = await request(app.getHttpServer()).post('/orders').set(authHeader(token)).set(key).expect(201);

    const orderId = first.body.id as string;
    expect(replay.body.id).toBe(orderId);
    // One order, one event: the replay is served from the frozen idempotency result and never
    // reaches the transaction, so a client retry storm cannot multiply events.
    expect(await readOutbox(orderId)).toHaveLength(1);
  });

  it("rolls the appended row back when the caller's transaction fails after it", async () => {
    // The REAL writer, in a transaction that succeeds through the append and then fails. This is the
    // only test that can catch `append` opening a transaction of its own: such a writer would commit
    // this row independently, and the outbox would carry an event for work that never happened.
    const writer = app.get<OutboxWriterPort>(OUTBOX_WRITER);
    const orderId = testId();
    const record: OutboxRecord = {
      aggregateType: 'Order',
      aggregateId: orderId,
      eventType: 'order.placed',
      payload: { orderId },
    };

    await expect(
      db.transaction(async (tx) => {
        await writer.append(tx, record);
        // Proves the insert landed, so the rollback assertion cannot pass on an empty write.
        expect(await tx.select().from(schema.outbox)).toHaveLength(1);
        throw new Error('caller failed after append');
      }),
    ).rejects.toThrow('caller failed after append');

    expect(await db.select().from(schema.outbox)).toHaveLength(0);
  });

  it('appends order.paid once in the finalize transaction, however often delivered', async () => {
    const sku = await seedSellableSku(app, { onHand: STOCK, priceMinor: PRICE });
    const open = await placeAndOpenSession(app, sku);
    await authorizePayment(open.orderId);
    const [job] = await relayedAuthorizations(app, open.orderId);
    const processor = app.get(DomainEventProcessor);

    await processor.process(job.data, ORDER_EVENTS_QUEUE);
    await processor.process(job.data, ORDER_EVENTS_QUEUE); // at-least-once delivery: the same job again
    await untilOrderStatus(app, open.orderId, 'PAID');

    const rows = await readOutbox(open.orderId);
    expect(rows.map((row) => row.eventType)).toEqual(['order.placed', 'order.paid']);
    expect(rows[1]).toMatchObject({ publishedAt: null, attempts: 0 });
    expect(rows[1].payload).toMatchObject({
      orderId: open.orderId,
      totalAmountMinor: PRICE,
      currency: 'VND',
      paymentRef: open.paymentId,
      occurredAt: expect.any(String),
    });
  });
});

// The Try has already committed its hold when the append fails, so the order waits in RESERVING
// for the outbox rather than rolling back; checkout-saga-try-failures covers the recovery.
describe('Outbox append failure strands the checkout in RESERVING (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  // A second boot, not a second test: the throwing writer is injected when the module compiles, and
  // the suite above needs the real one on the same routes.
  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool({}, [
      {
        provide: OUTBOX_WRITER,
        useValue: {
          append: () => Promise.reject(new Error('outbox unavailable')),
        },
      },
    ]));
  });
  closeAppAfterAll(() => app);
  resetSagasAndDatabaseBeforeEach(
    () => [app],
    () => pool,
  );

  it('answers 503 and keeps the order RESERVING with its hold and no event when the append throws', async () => {
    const sku = await seedSellableSku(app, { onHand: STOCK, priceMinor: PRICE });
    const token = await buyerWithCart(app, sku.variantId, 2);

    const res = await request(app.getHttpServer()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBeDefined();
    const [order] = await db.select().from(schema.orders);
    expect(order.status).toBe('RESERVING');
    expect((await readReservationOrder(app, order.id))?.status).toBe('HELD');
    expect(await db.select().from(schema.outbox)).toHaveLength(0);
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: STOCK, quantityReserved: 2 });
  });
});
