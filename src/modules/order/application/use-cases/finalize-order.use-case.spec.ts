import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import type { OutboxWriterPort } from '@shared/messaging/outbox/outbox-writer.port';
import type { MetricsPort } from '@shared/observability/metrics/metrics.port';
import { OrderStatus } from '../../domain/order-status';
import type { InventoryReservationPort } from '../ports/inventory-reservation.port';
import type { OrderRepositoryPort } from '../ports/order-repository.port';
import type { FinalizeResult } from './finalize-order.types';
import { FinalizeOrderUseCase } from './finalize-order.use-case';

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';

function build(withTransaction: () => Promise<FinalizeResult>) {
  const recordSagaStep = vi.fn();
  const recordCompensation = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn() };
  const useCase = new FinalizeOrderUseCase(
    { withTransaction: vi.fn(withTransaction) } as unknown as OrderRepositoryPort,
    {} as unknown as InventoryReservationPort,
    {} as unknown as OutboxWriterPort,
    { recordSagaStep, recordCompensation } as unknown as MetricsPort,
    logger as unknown as PinoLogger,
  );
  return { useCase, recordSagaStep, recordCompensation, logger };
}

// The settlement paths themselves are driven end-to-end against a real database; what is only
// reachable from here is what the unit reports about a settlement that never committed.
describe('FinalizeOrderUseCase', () => {
  it('counts a failed step when the transaction throws, and rethrows the original error', async () => {
    const boom = new Error('deadlock detected');
    const { useCase, recordSagaStep, recordCompensation, logger } = build(() => Promise.reject(boom));

    await expect(useCase.execute({ orderId: ORDER_ID, outcome: OrderStatus.FAILED })).rejects.toBe(boom);

    expect(recordSagaStep).toHaveBeenCalledExactlyOnceWith('finalize', 'failed');
    // Nothing rolled back, so nothing was compensated and no order reached an end state.
    expect(recordCompensation).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('counts nothing for a redelivery the terminal guard collapsed', async () => {
    const { useCase, recordSagaStep, recordCompensation, logger } = build(() =>
      Promise.resolve({ status: 'noop' } as FinalizeResult),
    );

    await expect(useCase.execute({ orderId: ORDER_ID, outcome: OrderStatus.PAID })).resolves.toMatchObject({
      status: 'noop',
    });

    expect(recordSagaStep).not.toHaveBeenCalled();
    expect(recordCompensation).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
