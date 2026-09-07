import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { Order } from '../../domain/order.entity';
import { OrderStatus } from '../../domain/order-status';
import type { OrderRepositoryPort } from '../ports/order-repository.port';
import { CancelOrderUseCase } from './cancel-order.use-case';
import type { FinalizeOrderUseCase } from './finalize-order.use-case';

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const OWNER = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const STRANGER = 'cccccccc-cccc-4ccc-8ccc-000000000001';

function order(status: OrderStatus, userId = OWNER): Order {
  return Order.rehydrate({
    id: ORDER_ID,
    userId,
    status,
    currency: 'VND',
    items: [],
    totalAmountMinor: 100_000,
    placedAt: new Date('2026-01-01T00:00:00Z'),
  });
}

function build(found: Order | null) {
  const findByIdForUpdate = vi.fn().mockResolvedValue(found);
  const repo = {
    // The real one opens a transaction; here it just supplies the handle the lookup takes.
    withTransaction: vi.fn(<T>(fn: (tx: DrizzleTx) => Promise<T>) => fn({} as DrizzleTx)),
    findByIdForUpdate,
  } as unknown as OrderRepositoryPort;
  const execute = vi.fn().mockImplementation(({ reason }: { reason: string }) =>
    Promise.resolve({
      status: 'finalized',
      order: Order.rehydrate({
        id: ORDER_ID,
        userId: OWNER,
        status: OrderStatus.CANCELLED,
        currency: 'VND',
        items: [],
        totalAmountMinor: 100_000,
        placedAt: new Date('2026-01-01T00:00:00Z'),
        finalizeReason: reason,
      }),
    }),
  );
  const useCase = new CancelOrderUseCase(repo, { execute } as unknown as FinalizeOrderUseCase);
  return { useCase, finalize: execute, findByIdForUpdate };
}

describe('CancelOrderUseCase', () => {
  it('cancels a pending order and stamps who asked', async () => {
    const { useCase, finalize } = build(order(OrderStatus.PENDING));

    await expect(useCase.cancelOwn(ORDER_ID, OWNER)).resolves.toMatchObject({
      id: ORDER_ID,
      status: OrderStatus.CANCELLED,
    });

    expect(finalize).toHaveBeenCalledExactlyOnceWith(
      { orderId: ORDER_ID, outcome: OrderStatus.CANCELLED, reason: 'user:cancel' },
      expect.anything(),
    );
  });

  it('joins the caller transaction rather than letting the finalize open its own', async () => {
    const { useCase, finalize, findByIdForUpdate } = build(order(OrderStatus.PENDING));

    await useCase.cancelOwn(ORDER_ID, OWNER);

    // The order was read under a lock and the finalize was handed that same handle — otherwise the
    // order could settle some other way between the ownership check and the cancel.
    expect(finalize.mock.calls[0][1]).toBe(findByIdForUpdate.mock.calls[0][1]);
  });

  it('records an admin force-cancel under its own audit reason', async () => {
    const { useCase, finalize } = build(order(OrderStatus.PENDING));

    await expect(useCase.cancelAsAdmin(ORDER_ID)).resolves.toMatchObject({ status: OrderStatus.CANCELLED });

    expect(finalize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: 'admin:cancel' }),
      expect.anything(),
    );
  });

  it("answers 404 for someone else's order, the same as one that does not exist", async () => {
    const { useCase, finalize } = build(order(OrderStatus.PENDING, STRANGER));

    await expect(useCase.cancelOwn(ORDER_ID, OWNER)).rejects.toBeInstanceOf(NotFoundException);
    expect(finalize).not.toHaveBeenCalled();
  });

  it('lets an admin cancel an order they do not own', async () => {
    const { useCase, finalize } = build(order(OrderStatus.PENDING, STRANGER));

    await expect(useCase.cancelAsAdmin(ORDER_ID)).resolves.toMatchObject({ status: OrderStatus.CANCELLED });
    expect(finalize).toHaveBeenCalledOnce();
  });

  it('answers 404 when no such order exists', async () => {
    const { useCase, finalize } = build(null);

    await expect(useCase.cancelOwn(ORDER_ID, OWNER)).rejects.toBeInstanceOf(NotFoundException);
    expect(finalize).not.toHaveBeenCalled();
  });

  it('is idempotent: re-cancelling answers 200 without settling twice', async () => {
    const { useCase, finalize } = build(order(OrderStatus.CANCELLED));

    await expect(useCase.cancelOwn(ORDER_ID, OWNER)).resolves.toMatchObject({ status: OrderStatus.CANCELLED });
    expect(finalize).not.toHaveBeenCalled();
  });

  it('refuses a paid order — unwinding it is a refund, not a cancel', async () => {
    const { useCase, finalize } = build(order(OrderStatus.PAID));

    await expect(useCase.cancelOwn(ORDER_ID, OWNER)).rejects.toBeInstanceOf(ConflictException);
    expect(finalize).not.toHaveBeenCalled();
  });

  it.each([OrderStatus.DRAFT, OrderStatus.FAILED, OrderStatus.EXPIRED])('refuses a %s order', async (status) => {
    const { useCase, finalize } = build(order(status));

    await expect(useCase.cancelOwn(ORDER_ID, OWNER)).rejects.toBeInstanceOf(ConflictException);
    expect(finalize).not.toHaveBeenCalled();
  });
});
