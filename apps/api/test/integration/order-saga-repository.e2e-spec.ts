import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_STORE,
  type IdempotencyStorePort,
} from '../../src/modules/order/application/ports/idempotency-store.port';
import {
  ORDER_REPOSITORY,
  TooManyPendingOrdersError,
  type OrderRepositoryPort,
} from '../../src/modules/order/application/ports/order-repository.port';
import { OrderItem } from '../../src/modules/order/domain/order-item.entity';
import { OrderStatus } from '../../src/modules/order/domain/order-status';
import { Order } from '../../src/modules/order/domain/order.entity';
import { MAX_PENDING_ORDERS_PER_USER } from '../../src/modules/order/order.constants';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

const DEADLINE_MS = 60 * 60_000;

describe('Order repository: saga writes (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let repo: OrderRepositoryPort;
  let idempotency: IdempotencyStorePort;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
    repo = app.get<OrderRepositoryPort>(ORDER_REPOSITORY);
    idempotency = app.get<IdempotencyStorePort>(IDEMPOTENCY_STORE);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const reservingOrder = (userId: string, placedAt = new Date()) =>
    Order.create(userId, 'VND', [OrderItem.of(testId(), 'Widget', 125_000, 2)]).reserve(
      placedAt,
      new Date(placedAt.getTime() + DEADLINE_MS),
    );

  const place = async (userId = testId(), idempotencyKey: string | null = null) => {
    const result = await repo.createReserving({ order: reservingOrder(userId), idempotencyKey });
    return result.order.id as string;
  };

  const readOrderRow = async (orderId: string) =>
    (
      await pool.query<{
        status: string;
        placed_at: Date | null;
        payment_deadline_at: Date | null;
        finalized_at: Date | null;
        finalize_reason: string | null;
        payment_ref: string | null;
        idempotency_key: string | null;
      }>(
        `SELECT status, placed_at, payment_deadline_at, finalized_at, finalize_reason, payment_ref, idempotency_key
           FROM orders WHERE id = $1`,
        [orderId],
      )
    ).rows[0];

  const outboxFor = async (orderId: string) =>
    (
      await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
        'SELECT event_type, payload FROM outbox WHERE aggregate_id = $1 ORDER BY created_at, id',
        [orderId],
      )
    ).rows;

  const setStatus = (orderId: string, status: OrderStatus) =>
    pool.query('UPDATE orders SET status = $2 WHERE id = $1', [orderId, status]);

  const openKey = async (userId: string, key: string) => {
    const record = await idempotency.tryInsertInProgress({
      ownerId: userId,
      scope: `user:${userId}`,
      key,
      requestHash: 'e2e',
      method: 'POST',
      path: '/orders',
      expiresAt: new Date(Date.now() + DEADLINE_MS),
    });
    expect(record).not.toBeNull();
  };

  describe('createReserving', () => {
    it('writes a RESERVING order with its deadline and items, and nothing else', async () => {
      const userId = testId();
      const order = reservingOrder(userId);

      const result = await repo.createReserving({ order, idempotencyKey: 'key-1' });

      expect(result.created).toBe(true);
      const orderId = result.order.id as string;
      expect(result.order).toMatchObject({ status: OrderStatus.RESERVING, paymentDeadlineAt: order.paymentDeadlineAt });
      expect(await readOrderRow(orderId)).toMatchObject({
        status: 'RESERVING',
        placed_at: order.placedAt,
        payment_deadline_at: order.paymentDeadlineAt,
        idempotency_key: 'key-1',
      });
      expect((await repo.findById(orderId))?.items).toHaveLength(1);
      expect(await outboxFor(orderId)).toEqual([]);
      const { rows } = await pool.query('SELECT 1 FROM reservations WHERE order_id = $1', [orderId]);
      expect(rows).toEqual([]);
    });

    it('counts RESERVING, PENDING and CONFIRMING orders against the cap, and no settled one', async () => {
      const userId = testId();
      const settled = await place(userId);
      await setStatus(settled, OrderStatus.REJECTED);
      const open: string[] = [];
      for (let i = 0; i < MAX_PENDING_ORDERS_PER_USER; i++) open.push(await place(userId));
      await setStatus(open[0], OrderStatus.PENDING);
      await setStatus(open[1], OrderStatus.CONFIRMING);

      await expect(place(userId)).rejects.toBeInstanceOf(TooManyPendingOrdersError);

      await setStatus(open[0], OrderStatus.PAID);
      await expect(place(userId)).resolves.toEqual(expect.any(String));
    });

    it('returns the order already placed under the key, whatever its status', async () => {
      const userId = testId();
      const first = await repo.createReserving({ order: reservingOrder(userId), idempotencyKey: 'key-2' });
      await setStatus(first.order.id as string, OrderStatus.PENDING);

      const again = await repo.createReserving({ order: reservingOrder(userId), idempotencyKey: 'key-2' });

      expect(again.created).toBe(false);
      expect(again.order).toMatchObject({ id: first.order.id, status: OrderStatus.PENDING });
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders WHERE user_id = $1', [userId]);
      expect(rows[0].n).toBe(1);
    });
  });

  describe('applyTryResult', () => {
    it('places the order on a hold: PENDING, one order.placed, the key frozen with the 201 body', async () => {
      const userId = testId();
      const key = randomUUID();
      await openKey(userId, key);
      const orderId = await place(userId, key);

      expect(await repo.applyTryResult({ orderId, outcome: 'HELD', reason: null })).toBe('applied');

      expect((await readOrderRow(orderId)).status).toBe('PENDING');
      const events = await outboxFor(orderId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event_type: 'order.placed',
        payload: { orderId, userId, totalAmountMinor: 250_000, currency: 'VND' },
      });
      const record = await idempotency.findByScopeAndKey(`user:${userId}`, key);
      expect(record).toMatchObject({ status: 'COMPLETED', responseStatus: 201, orderId });
      expect(record?.responseBody).toMatchObject({ id: orderId, status: 'PENDING', totalAmountMinor: 250_000 });
    });

    it('answers already for a repeat and writes nothing more', async () => {
      const orderId = await place();
      await repo.applyTryResult({ orderId, outcome: 'HELD', reason: null });

      expect(await repo.applyTryResult({ orderId, outcome: 'HELD', reason: null })).toBe('already');
      expect(await outboxFor(orderId)).toHaveLength(1);
    });

    it('rejects the order on a failed Try and frees the key for a fresh order', async () => {
      const userId = testId();
      const orderId = await place(userId, 'key-3');

      expect(await repo.applyTryResult({ orderId, outcome: 'OUT_OF_STOCK', reason: 'saga:try_failed' })).toBe(
        'applied',
      );

      const row = await readOrderRow(orderId);
      expect(row).toMatchObject({ status: 'REJECTED', finalize_reason: 'saga:try_failed', idempotency_key: null });
      expect(row.finalized_at).toBeInstanceOf(Date);
      expect(await outboxFor(orderId)).toEqual([]);
      expect(await repo.applyTryResult({ orderId, outcome: 'TIMEOUT', reason: 'saga:try_timeout' })).toBe('already');

      const retry = await repo.createReserving({ order: reservingOrder(userId), idempotencyKey: 'key-3' });
      expect(retry.created).toBe(true);
      expect(retry.order.id).not.toBe(orderId);
    });

    it('answers stale when the order moved somewhere the result does not lead', async () => {
      const held = await place();
      await repo.applyTryResult({ orderId: held, outcome: 'HELD', reason: null });
      const rejected = await place();
      await repo.applyTryResult({ orderId: rejected, outcome: 'ABANDONED', reason: 'saga:abandoned' });

      expect(await repo.applyTryResult({ orderId: held, outcome: 'ERROR', reason: 'saga:try_timeout' })).toBe('stale');
      expect(await repo.applyTryResult({ orderId: rejected, outcome: 'HELD', reason: null })).toBe('stale');
      expect((await readOrderRow(held)).status).toBe('PENDING');
      expect((await readOrderRow(rejected)).status).toBe('REJECTED');
    });
  });

  describe('applyOrderChange', () => {
    const pending = async () => {
      const orderId = await place();
      await repo.applyTryResult({ orderId, outcome: 'HELD', reason: null });
      return orderId;
    };

    it('confirms without an event, then pays with the payment ref and order.paid', async () => {
      const orderId = await pending();

      expect(
        await repo.applyOrderChange({ orderId, from: [OrderStatus.PENDING], to: OrderStatus.CONFIRMING, reason: null }),
      ).toBe('applied');
      expect((await readOrderRow(orderId)).status).toBe('CONFIRMING');
      expect((await outboxFor(orderId)).map((event) => event.event_type)).toEqual(['order.placed']);

      expect(
        await repo.applyOrderChange({
          orderId,
          from: [OrderStatus.CONFIRMING],
          to: OrderStatus.PAID,
          reason: 'saga:captured',
          paymentRef: 'pay-77',
        }),
      ).toBe('applied');

      const row = await readOrderRow(orderId);
      expect(row).toMatchObject({ status: 'PAID', payment_ref: 'pay-77', finalize_reason: 'saga:captured' });
      expect(row.finalized_at).toBeInstanceOf(Date);
      const events = await outboxFor(orderId);
      expect(events.map((event) => event.event_type)).toEqual(['order.placed', 'order.paid']);
      expect(events[1].payload).toMatchObject({ orderId, totalAmountMinor: 250_000, paymentRef: 'pay-77' });
    });

    it.each([
      [OrderStatus.CANCELLED, 'order.cancelled', 'user:cancel'],
      [OrderStatus.EXPIRED, 'order.expired', 'saga:expired'],
    ])('settles a pending order to %s with %s', async (to, eventType, reason) => {
      const orderId = await pending();

      expect(await repo.applyOrderChange({ orderId, from: [OrderStatus.PENDING], to, reason })).toBe('applied');

      const events = await outboxFor(orderId);
      expect(events.map((event) => event.event_type)).toEqual(['order.placed', eventType]);
      expect(events[1].payload).toMatchObject({ orderId, reason });
    });

    it('fails a confirming order with order.failed', async () => {
      const orderId = await pending();
      await repo.applyOrderChange({ orderId, from: [OrderStatus.PENDING], to: OrderStatus.CONFIRMING, reason: null });

      await repo.applyOrderChange({
        orderId,
        from: [OrderStatus.CONFIRMING],
        to: OrderStatus.FAILED,
        reason: 'saga:commit_conflict',
      });

      expect((await outboxFor(orderId)).map((event) => event.event_type)).toEqual(['order.placed', 'order.failed']);
    });

    it('answers already for a repeat and stale when the order left the source', async () => {
      const orderId = await pending();
      const cancel = { orderId, from: [OrderStatus.PENDING], to: OrderStatus.CANCELLED, reason: 'user:cancel' };
      await repo.applyOrderChange(cancel);

      expect(await repo.applyOrderChange(cancel)).toBe('already');
      expect(
        await repo.applyOrderChange({
          orderId,
          from: [OrderStatus.PENDING],
          to: OrderStatus.EXPIRED,
          reason: 'saga:expired',
        }),
      ).toBe('stale');
      expect((await readOrderRow(orderId)).status).toBe('CANCELLED');
      expect(await outboxFor(orderId)).toHaveLength(2);
    });

    it('answers stale for an order that does not exist', async () => {
      expect(
        await repo.applyOrderChange({
          orderId: testId(),
          from: [OrderStatus.PENDING],
          to: OrderStatus.CONFIRMING,
          reason: null,
        }),
      ).toBe('stale');
    });
  });
});
