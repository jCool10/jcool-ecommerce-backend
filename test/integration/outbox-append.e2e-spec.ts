import type { INestApplication } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import {
  OUTBOX_WRITER,
  type OutboxRecord,
  type OutboxWriterPort,
} from '../../src/shared/messaging/outbox/outbox-writer.port';
import { authHeader } from '../setup/auth.helper';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import {
  seedSellableSku,
  buyerWithCart,
  placeAndOpenSession,
  postWebhook,
  signOutcome,
} from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

const WEBHOOK_SECRET = 'whsec_e2e_outbox_secret_0123456789';
const STOCK = 5;
const PRICE = 150_000;

// The transactional outbox over real Postgres: an event is written by the SAME transaction as the
// business change it describes, so the two can never disagree. Nothing publishes yet — these tests
// assert the write side only (`published_at` stays NULL, which is the relay's work queue).
describe('Transactional outbox append (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool({ PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET }));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

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
    // Tracing is off in e2e, so there is no active span to capture — the column stays null rather
    // than holding a malformed header. Trace continuity is asserted where the relay consumes it.
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

  it('rolls the appended row back when the caller’s transaction fails after the append', async () => {
    // The REAL writer, in a transaction that succeeds through the append and then fails. This is the
    // only test that can catch `append` opening a transaction of its own: such a writer would commit
    // this row independently, and the outbox would carry an event for work that never happened.
    const writer = app.get<OutboxWriterPort>(OUTBOX_WRITER);
    const record: OutboxRecord = {
      aggregateType: 'Order',
      aggregateId: '01a03000-0000-7000-8000-0000000000ff',
      eventType: 'order.placed',
      payload: { orderId: '01a03000-0000-7000-8000-0000000000ff' },
    };

    await expect(
      db.transaction(async (tx) => {
        await writer.append(tx, record);
        // The insert really landed inside this transaction before it is undone — otherwise the
        // assertion below would pass for the trivial reason that nothing was ever written.
        expect(await tx.select().from(schema.outbox)).toHaveLength(1);
        throw new Error('caller failed after append');
      }),
    ).rejects.toThrow('caller failed after append');

    expect(await db.select().from(schema.outbox)).toHaveLength(0);
  });

  it('appends order.paid in the finalize transaction, once, however often the webhook is delivered', async () => {
    const sku = await seedSellableSku(app, { onHand: STOCK, priceMinor: PRICE });
    const open = await placeAndOpenSession(app, sku);
    const signed = signOutcome(WEBHOOK_SECRET, open.sessionId, open.charge, 'PAID', 'evt_outbox_paid');

    await postWebhook(app, signed).expect(200);
    await postWebhook(app, signed).expect(200); // at-least-once delivery: the same event again

    const rows = await readOutbox(open.orderId);
    expect(rows.map((row) => row.eventType)).toEqual(['order.placed', 'order.paid']);
    expect(rows[1]).toMatchObject({ publishedAt: null, attempts: 0 });
    expect(rows[1].payload).toMatchObject({
      orderId: open.orderId,
      totalAmountMinor: open.charge.amountMinor,
      currency: open.charge.currency,
      paymentRef: expect.any(String),
      occurredAt: expect.any(String),
    });
  });
});

// The other direction: a writer that FAILS must take the whole checkout down with it, so an event
// the system could not record is never silently skipped in favour of a placed order. The writer is
// stubbed here, so this says nothing about the real one opening its own transaction — proved above.
describe('Outbox append failure rolls back the checkout (integration, real Postgres)', () => {
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
  resetDatabaseBeforeEach(() => pool);

  it('leaves no order, no event, and no stock hold when the append throws', async () => {
    const sku = await seedSellableSku(app, { onHand: STOCK, priceMinor: PRICE });
    const token = await buyerWithCart(app, sku.variantId, 2);

    await request(app.getHttpServer()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader()).expect(500);

    expect(await db.select().from(schema.orders)).toHaveLength(0);
    expect(await db.select().from(schema.outbox)).toHaveLength(0);
    expect(await db.select().from(schema.reservations)).toHaveLength(0);
    // Stock untouched: the hold rolled back with everything else.
    const [stock] = await db.select().from(schema.stockLevels).where(eq(schema.stockLevels.variantId, sku.variantId));
    expect(stock).toMatchObject({ quantityOnHand: STOCK, quantityReserved: 0 });
  });
});
