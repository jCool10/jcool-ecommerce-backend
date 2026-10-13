import { describe, expect, it, vi } from 'vitest';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type { OutboxWriterPort } from '@shared/messaging/outbox/outbox-writer.port';
import { sampleId } from '@shared/testing/id-generator.double';
import { Order } from '../../domain/order.entity';
import { OrderItem } from '../../domain/order-item.entity';
import { OrderStatus } from '../../domain/order-status';
import type { OrderRepositoryPort } from '../ports/order-repository.port';
import { CheckoutOrderWriter, SagaOrderMissingError } from './checkout-order.writer';

const ORDER_ID = sampleId(1);
const EVENT_ID = sampleId(2);
const TX = { tx: true } as unknown as DrizzleTx;
const NOW = new Date('2026-03-01T09:05:00.000Z');

const orderIn = (status: OrderStatus): Order =>
  Order.rehydrate({
    id: ORDER_ID,
    userId: 'u1',
    status,
    currency: 'VND',
    items: [OrderItem.of('sku-1', 'Widget', 120_000, 2)],
    totalAmountMinor: 240_000,
    placedAt: new Date('2026-03-01T09:00:00.000Z'),
    paymentDeadlineAt: new Date('2026-03-01T10:00:00.000Z'),
  });

function build(found: Order | null) {
  const log: string[] = [];
  const orders = {
    withTransaction: vi.fn(async <T>(run: (tx: DrizzleTx) => Promise<T>) => {
      log.push('begin');
      const result = await run(TX);
      log.push('commit');
      return result;
    }),
    findByIdForUpdate: vi.fn(() => Promise.resolve(found)),
    saveStatus: vi.fn((order: Order) => {
      log.push(`save ${order.status}`);
      return Promise.resolve();
    }),
    clearIdempotencyKey: vi.fn(() => {
      log.push('clear key');
      return Promise.resolve();
    }),
  };
  const outbox = { append: vi.fn<OutboxWriterPort['append']>(() => Promise.resolve()) };
  const ids = {
    mint: vi.fn(() => {
      log.push('mint');
      return Promise.resolve([EVENT_ID]);
    }),
  };
  const writer = new CheckoutOrderWriter(orders as unknown as OrderRepositoryPort, outbox, ids);
  return { writer, orders, outbox, ids, log };
}

describe('CheckoutOrderWriter', () => {
  it('places a reserving order with its event, minting the id before the row lock', async () => {
    const { writer, outbox, log } = build(orderIn(OrderStatus.RESERVING));
    const inTx = vi.fn(() => Promise.resolve());

    await expect(
      writer.apply({ orderId: ORDER_ID, from: OrderStatus.RESERVING, change: { status: OrderStatus.PENDING }, inTx }),
    ).resolves.toBe('written');

    expect(log).toEqual(['mint', 'begin', `save ${OrderStatus.PENDING}`, 'commit']);
    expect(outbox.append).toHaveBeenCalledExactlyOnceWith(
      TX,
      expect.objectContaining({ eventType: 'order.placed', aggregateId: ORDER_ID }),
      EVENT_ID,
    );
    expect(inTx).toHaveBeenCalledExactlyOnceWith(TX, expect.objectContaining({ status: OrderStatus.PENDING }));
  });

  it('rejects with a stamped reason, frees the key and emits nothing', async () => {
    const { writer, orders, outbox, ids } = build(orderIn(OrderStatus.RESERVING));

    await writer.apply({
      orderId: ORDER_ID,
      from: OrderStatus.RESERVING,
      change: { status: OrderStatus.REJECTED, reason: 'try:out_of_stock' },
      now: NOW,
    });

    expect(orders.saveStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: OrderStatus.REJECTED, finalizedAt: NOW, finalizeReason: 'try:out_of_stock' }),
      TX,
    );
    expect(orders.clearIdempotencyKey).toHaveBeenCalledExactlyOnceWith(ORDER_ID, TX);
    expect(ids.mint).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('moves to confirming without an event', async () => {
    const { writer, outbox, ids } = build(orderIn(OrderStatus.PENDING));

    await writer.apply({ orderId: ORDER_ID, from: OrderStatus.PENDING, change: { status: OrderStatus.CONFIRMING } });

    expect(ids.mint).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it.each([
    [OrderStatus.PAID, OrderStatus.CONFIRMING, 'order.paid'],
    [OrderStatus.FAILED, OrderStatus.CONFIRMING, 'order.failed'],
    [OrderStatus.EXPIRED, OrderStatus.PENDING, 'order.expired'],
    [OrderStatus.CANCELLED, OrderStatus.PENDING, 'order.cancelled'],
  ] as const)('settles to %s with its reason and event', async (status, from, eventType) => {
    const { writer, orders, outbox } = build(orderIn(from));

    await writer.apply({ orderId: ORDER_ID, from, change: { status, reason: 'because' }, now: NOW });

    expect(orders.saveStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status, finalizedAt: NOW, finalizeReason: 'because' }),
      TX,
    );
    expect(outbox.append).toHaveBeenCalledWith(TX, expect.objectContaining({ eventType }), EVENT_ID);
  });

  // A retry after a commit whose answer was lost must not write the event a second time.
  it('writes nothing when an earlier attempt already made the change', async () => {
    const { writer, orders, outbox } = build(orderIn(OrderStatus.PENDING));
    const inTx = vi.fn();

    await expect(
      writer.apply({ orderId: ORDER_ID, from: OrderStatus.RESERVING, change: { status: OrderStatus.PENDING }, inTx }),
    ).resolves.toBe('already');

    expect(orders.saveStatus).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
    expect(inTx).not.toHaveBeenCalled();
  });

  it('leaves an order that moved somewhere else untouched', async () => {
    const { writer, orders, outbox } = build(orderIn(OrderStatus.CANCELLED));

    await expect(
      writer.apply({
        orderId: ORDER_ID,
        from: OrderStatus.PENDING,
        change: { status: OrderStatus.EXPIRED, reason: 'deadline' },
      }),
    ).resolves.toBe('stale');

    expect(orders.saveStatus).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('refuses an order that does not exist', async () => {
    const { writer } = build(null);

    await expect(
      writer.apply({ orderId: ORDER_ID, from: OrderStatus.RESERVING, change: { status: OrderStatus.PENDING } }),
    ).rejects.toBeInstanceOf(SagaOrderMissingError);
  });
});
