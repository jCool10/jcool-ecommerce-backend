import { HttpException } from '@nestjs/common';
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

function build(found: Order | null, reportFinalized?: () => void) {
  const findByIdForUpdate = vi.fn().mockResolvedValue(found);
  // Stands in for the COMMIT so a test can tell what ran inside the transaction from what ran after.
  const commit = vi.fn();
  const repo = {
    withTransaction: vi.fn(async <T>(fn: (tx: DrizzleTx) => Promise<T>) => {
      const outcome = await fn({} as DrizzleTx);
      commit();
      return outcome;
    }),
    findByIdForUpdate,
  } as unknown as OrderRepositoryPort;
  const execute = vi.fn().mockResolvedValue({
    status: 'finalized',
    reportFinalized,
    order: order(OrderStatus.CANCELLED),
  });
  const useCase = new CancelOrderUseCase(repo, { execute } as unknown as FinalizeOrderUseCase);
  return { useCase, finalize: execute, findByIdForUpdate, commit };
}

describe('CancelOrderUseCase', () => {
  it('joins the caller transaction rather than letting the finalize open its own', async () => {
    const { useCase, finalize, findByIdForUpdate } = build(order(OrderStatus.PENDING));

    await useCase.cancelOwn(ORDER_ID, OWNER);

    // Otherwise the order could settle some other way between the ownership check and the cancel.
    expect(finalize.mock.calls[0][1]).toBe(findByIdForUpdate.mock.calls[0][1]);
  });

  it('runs the finalize reporting only after the transaction commits', async () => {
    const report = vi.fn();
    const { useCase, commit } = build(order(OrderStatus.PENDING), report);

    await useCase.cancelOwn(ORDER_ID, OWNER);

    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.invocationCallOrder[0]).toBeGreaterThan(commit.mock.invocationCallOrder[0]);
  });

  it("refuses a missing or someone else's order with 404 and any non-pending one with 409", async () => {
    const cases: Array<[string, Order | null]> = [
      ['missing', null],
      ["stranger's", order(OrderStatus.PENDING, STRANGER)],
      ...[OrderStatus.PAID, OrderStatus.DRAFT, OrderStatus.FAILED, OrderStatus.EXPIRED].map(
        (status): [string, Order] => [status, order(status)],
      ),
    ];

    const outcomes = await Promise.all(
      cases.map(async ([label, found]) => {
        const { useCase, finalize } = build(found);
        const status = await useCase.cancelOwn(ORDER_ID, OWNER).then(
          () => 'resolved',
          (error: unknown) => (error instanceof HttpException ? error.getStatus() : error),
        );
        return [label, status, finalize.mock.calls.length];
      }),
    );

    expect(outcomes).toEqual([
      ['missing', 404, 0],
      ["stranger's", 404, 0],
      [OrderStatus.PAID, 409, 0],
      [OrderStatus.DRAFT, 409, 0],
      [OrderStatus.FAILED, 409, 0],
      [OrderStatus.EXPIRED, 409, 0],
    ]);
  });
});
