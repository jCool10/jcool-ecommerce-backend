import type { INestApplication } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import {
  OUTBOX_WRITER,
  type OutboxRecord,
  type OutboxWriterPort,
} from '../../src/shared/messaging/outbox/outbox-writer.port';
import { authHeader } from '../setup/bearer.helper';
import { drainDomainEvents } from '../setup/domain-events';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import {
  authorizeAndRelay,
  buyerWithCart,
  describeSaga,
  placeAndOpenSession,
  postWebhook,
  readOrder,
  readReservationOrder,
  readSagaState,
  readStock,
  seedSellableSku,
} from '../setup/fixtures/order-flow.fixture';
import {
  closeAppAfterAll,
  createTestAppWithFakeGateway,
  createTestAppWithPool,
  resetDatabaseBeforeEach,
} from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { checkoutSessionCompleted, signWebhookAs } from '../setup/sign-webhook.helper';

const WEBHOOK_SECRET = 'whsec_e2e_outbox_secret_0123456789';
const STOCK = 5;
const PRICE = 150_000;

// An event is written by the same transaction as the business change it describes, so the two can
// never disagree. These tests assert the write side only: `published_at` stays NULL for the relay.
describe('Transactional outbox append (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let gateway: FakeSignerGatewayAdapter;

  beforeAll(async () => {
    ({ app, pool, db, gateway } = await createTestAppWithFakeGateway(WEBHOOK_SECRET));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const readOutbox = (orderId: string) =>
    db.select().from(schema.outbox).where(eq(schema.outbox.aggregateId, orderId)).orderBy(asc(schema.outbox.createdAt));

  it('appends exactly one unpublished order.placed row in the transaction that places the order', async () => {
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

  it('appends order.paid once, in the transaction that applies the capture, however often the hold is reported', async () => {
    const sku = await seedSellableSku(app, { onHand: STOCK, priceMinor: PRICE });
    const open = await placeAndOpenSession(app, sku);
    const eventId = `evt_outbox_paid_${open.orderId}`;

    await authorizeAndRelay(app, gateway, open, { eventId });
    // At-least-once delivery: the same event again, after the order is already paid.
    const repeat = checkoutSessionCompleted(open.sessionId, { ...open.charge, paymentStatus: 'unpaid' }, { eventId });
    await postWebhook(app, signWebhookAs(gateway, repeat)).expect(200);
    await drainDomainEvents(app);

    const rows = await readOutbox(open.orderId);
    expect(rows.map((row) => row.eventType)).toEqual(['order.placed', 'order.paid']);
    expect(rows[1].payload).toMatchObject({
      orderId: open.orderId,
      totalAmountMinor: open.charge.amountMinor,
      currency: open.charge.currency,
      occurredAt: expect.any(String),
    });
  });
});

// A placement whose event cannot be recorded must never stand: the order stays unplaced, and the
// saga keeps retrying the write until the outbox accepts it.
describe('Outbox append failure on placement (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let outboxDown = true;

  // A second boot, not a second test: the failing writer is injected when the module compiles, and
  // the suite above needs the real one on the same routes. Once healthy it appends like the real one.
  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool(
      {
        CHECKOUT_TRY_TIMEOUT_MS: '1000',
        INVENTORY_TRY_LOCK_TIMEOUT_MS: '500',
        CHECKOUT_RESERVE_WAIT_MS: '3000',
        SAGA_RETRY_BASE_MS: '200',
        SAGA_RETRY_CAP_MS: '2000',
      },
      [
        {
          provide: OUTBOX_WRITER,
          useValue: {
            append: async (tx, record, id) => {
              if (outboxDown) throw new Error('outbox unavailable');
              await tx.insert(schema.outbox).values({ id: id ?? testId(), ...record });
            },
          } satisfies OutboxWriterPort,
        },
      ],
    ));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  beforeEach(() => {
    outboxDown = true;
  });

  it('leaves the order unplaced, with no event, while the append throws, and places it once the outbox recovers', async () => {
    const sku = await seedSellableSku(app, { onHand: STOCK, priceMinor: PRICE });
    const token = await buyerWithCart(app, sku.variantId, 2);

    const response = await request(app.getHttpServer())
      .post('/orders')
      .set(authHeader(token))
      .set(idempotencyKeyHeader())
      .expect(503);

    expect(response.headers['retry-after']).toBeDefined();
    const [order] = await db.select().from(schema.orders);
    expect(order.status).toBe('RESERVING');
    expect(await db.select().from(schema.outbox)).toHaveLength(0);
    expect((await describeSaga(app, order.id))?.status.name).toBe('RUNNING');

    outboxDown = false;
    await vi.waitFor(async () => expect((await readOrder(app, order.id)).status).toBe('PENDING'), {
      timeout: 15_000,
      interval: 100,
    });

    expect(await readSagaState(app, order.id)).toMatchObject({ step: 'AWAITING_AUTH' });
    expect(await readReservationOrder(app, order.id)).toMatchObject({ status: 'HELD' });
    expect(await readStock(app, sku.variantId)).toMatchObject({ quantityOnHand: STOCK, quantityReserved: 2 });
    const events = await db.select().from(schema.outbox);
    expect(events.map((row) => row.eventType)).toEqual(['order.placed']);
  });
});
