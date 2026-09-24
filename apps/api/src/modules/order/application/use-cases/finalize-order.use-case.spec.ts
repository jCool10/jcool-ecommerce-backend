import { describe, expect, it, vi } from 'vitest';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type { OutboxWriterPort } from '@shared/messaging/outbox/outbox-writer.port';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { OrderStatus } from '../../domain/order-status';
import type { InventoryReservationPort } from '../ports/inventory-reservation.port';
import type { OrderRepositoryPort } from '../ports/order-repository.port';
import type { FinalizeResult } from './finalize-order.types';
import { FinalizeOrderUseCase } from './finalize-order.use-case';

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const CALLER_TX = Symbol('tx') as unknown as DrizzleTx;

function build(withTransaction: () => Promise<FinalizeResult>) {
  const metrics = fakeMetricsPort();
  const info = vi.fn();
  const useCase = new FinalizeOrderUseCase(
    { withTransaction: vi.fn(withTransaction) } as unknown as OrderRepositoryPort,
    {} as unknown as InventoryReservationPort,
    {} as unknown as OutboxWriterPort,
    metrics,
    fakePinoLogger({ info }),
  );
  return { useCase, metrics, info };
}

// The settlement paths are driven end-to-end against a real database; only the reporting around a
// settlement that did or did not commit is reachable from here.
describe('FinalizeOrderUseCase', () => {
  it('counts a failed step when the transaction throws, and rethrows the original error', async () => {
    const boom = new Error('deadlock detected');
    const { useCase, metrics, info } = build(() => Promise.reject(boom));

    await expect(useCase.execute({ orderId: ORDER_ID, outcome: OrderStatus.FAILED })).rejects.toBe(boom);

    expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('finalize', 'failed');
    expect(metrics.recordCompensation).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('counts nothing for a redelivery the terminal guard collapsed', async () => {
    const { useCase, metrics, info } = build(() => Promise.resolve({ status: 'noop' } as FinalizeResult));

    await expect(useCase.execute({ orderId: ORDER_ID, outcome: OrderStatus.PAID })).resolves.toMatchObject({
      status: 'noop',
    });

    expect(metrics.recordSagaStep).not.toHaveBeenCalled();
    expect(metrics.recordCompensation).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  // A joined caller commits later, so reporting before its commit would describe an end state the
  // database may never reach.
  it('reports nothing itself when it joined a caller transaction, and hands the reporting back', async () => {
    const { useCase, metrics, info } = build(() => Promise.resolve({ status: 'finalized' } as FinalizeResult));

    const result = await useCase.execute({ orderId: ORDER_ID, outcome: OrderStatus.CANCELLED }, CALLER_TX);

    expect(metrics.recordSagaStep).not.toHaveBeenCalled();
    expect(metrics.recordCompensation).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();

    result.reportFinalized?.();

    expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('finalize', 'success');
    expect(metrics.recordCompensation).toHaveBeenCalledExactlyOnceWith('cancelled');
    expect(info).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ orderId: ORDER_ID, outcome: OrderStatus.CANCELLED }),
      expect.any(String),
    );
  });

  it('reports immediately when it owned the transaction, leaving nothing for the caller', async () => {
    const { useCase, metrics, info } = build(() => Promise.resolve({ status: 'finalized' } as FinalizeResult));

    const result = await useCase.execute({ orderId: ORDER_ID, outcome: OrderStatus.PAID });

    expect(result.reportFinalized).toBeUndefined();
    expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('finalize', 'success');
    expect(metrics.recordCompensation).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledOnce();
  });
});
