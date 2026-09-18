import { describe, expect, it, vi } from 'vitest';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type { OutboxWriterPort } from '@shared/messaging/outbox/outbox-writer.port';
import { fakeMetricsPort } from '@shared/testing/fake-metrics-port';
import { fakePinoLogger } from '@shared/testing/fake-pino-logger';
import { OrderStatus } from '../../domain/order-status';
import type { InventoryReservationPort } from '../ports/inventory-reservation.port';
import type { OrderRepositoryPort } from '../ports/order-repository.port';
import type { FinalizeResult } from './finalize-order.types';
import { FinalizeOrderUseCase } from './finalize-order.use-case';

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const CALLER_TX = Symbol('tx') as unknown as DrizzleTx;

function build(withTransaction: () => Promise<FinalizeResult>) {
  const recordSagaStep = vi.fn();
  const recordCompensation = vi.fn();
  const logger = { info: vi.fn(), setContext: vi.fn() };
  const useCase = new FinalizeOrderUseCase(
    { withTransaction: vi.fn(withTransaction) } as unknown as OrderRepositoryPort,
    {} as unknown as InventoryReservationPort,
    {} as unknown as OutboxWriterPort,
    fakeMetricsPort({ recordSagaStep, recordCompensation }),
    fakePinoLogger(logger),
  );
  return { useCase, recordSagaStep, recordCompensation, logger };
}

// The settlement paths themselves are driven end-to-end against a real database; what is only
// reachable from here is what the unit reports about a settlement that never committed.
describe('FinalizeOrderUseCase', () => {
  // The `context` label every line of this use case is filtered by. It is set once on the transient
  // logger rather than stamped per call, so this constructor call is the only place it is observable
  // — the e2e spy sees the call-site arguments, before nestjs-pino merges the label in.
  it('labels its logger once, at construction', () => {
    const { logger } = build(() => Promise.resolve({ status: 'noop' } as FinalizeResult));

    expect(logger.setContext).toHaveBeenCalledExactlyOnceWith('FinalizeOrder');
  });

  it('counts a failed step when the transaction throws, and rethrows the original error', async () => {
    const boom = new Error('deadlock detected');
    const { useCase, recordSagaStep, recordCompensation, logger } = build(() => Promise.reject(boom));

    await expect(useCase.execute({ orderId: ORDER_ID, outcome: OrderStatus.FAILED })).rejects.toBe(boom);

    expect(recordSagaStep).toHaveBeenCalledExactlyOnceWith('finalize', 'failed');
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

  // A joined caller commits later, so reporting before its commit would describe an end state the
  // database may never reach.
  it('reports nothing itself when it joined a caller transaction, and hands the reporting back', async () => {
    const { useCase, recordSagaStep, recordCompensation, logger } = build(() =>
      Promise.resolve({ status: 'finalized' } as FinalizeResult),
    );

    const result = await useCase.execute({ orderId: ORDER_ID, outcome: OrderStatus.CANCELLED }, CALLER_TX);

    expect(recordSagaStep).not.toHaveBeenCalled();
    expect(recordCompensation).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();

    result.reportFinalized?.();

    expect(recordSagaStep).toHaveBeenCalledExactlyOnceWith('finalize', 'success');
    expect(recordCompensation).toHaveBeenCalledExactlyOnceWith('cancelled');
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ orderId: ORDER_ID, outcome: OrderStatus.CANCELLED }),
      'order finalized',
    );
  });

  it('reports immediately when it owned the transaction, with nothing left for the caller to run', async () => {
    const { useCase, recordSagaStep, recordCompensation, logger } = build(() =>
      Promise.resolve({ status: 'finalized' } as FinalizeResult),
    );

    const result = await useCase.execute({ orderId: ORDER_ID, outcome: OrderStatus.PAID });

    expect(result.reportFinalized).toBeUndefined();
    expect(recordSagaStep).toHaveBeenCalledExactlyOnceWith('finalize', 'success');
    expect(recordCompensation).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledOnce();
  });
});
