import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderStatus } from '../../domain/order-status';
import type { Order } from '../../domain/order.entity';
import type { ExpiredHold, InventoryReservationPort } from '../ports/inventory-reservation.port';
import type { FinalizeOrderUseCase } from './finalize-order.use-case';
import type { FinalizeResult } from './finalize-order.types';
import { SweepExpiredReservationsUseCase } from './sweep-expired-reservations.use-case';

const INPUT = { graceSec: 900, batchSize: 50 };
const NOW = new Date('2026-08-27T12:00:00.000Z');

function hold(n: number, minutesPastExpiry = 30): ExpiredHold {
  return {
    orderId: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${n}`,
    expiresAt: new Date(NOW.getTime() - minutesPastExpiry * 60_000),
  };
}

function finalized(): FinalizeResult {
  return { status: 'finalized', order: { status: OrderStatus.EXPIRED } as Order };
}

function build(holds: ExpiredHold[], execute = vi.fn().mockResolvedValue(finalized())) {
  const findExpiredHolds = vi.fn().mockResolvedValue(holds);
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const useCase = new SweepExpiredReservationsUseCase(
    { findExpiredHolds } as unknown as InventoryReservationPort,
    { execute } as unknown as FinalizeOrderUseCase,
    logger as unknown as PinoLogger,
  );
  return { useCase, findExpiredHolds, execute, logger };
}

describe('SweepExpiredReservationsUseCase', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('expires every lapsed hold it is handed', async () => {
    const { useCase, execute } = build([hold(1), hold(2)]);

    const summary = await useCase.execute(INPUT);

    expect(summary).toEqual({ scanned: 2, expired: 2, raced: 0, errors: 0 });
    expect(execute).toHaveBeenCalledWith({
      orderId: hold(1).orderId,
      outcome: OrderStatus.EXPIRED,
      reason: 'ttl:expired',
    });
  });

  it('subtracts the grace from now, so a hold is claimed only once it is that much overdue', async () => {
    const { useCase, findExpiredHolds } = build([]);

    await useCase.execute({ graceSec: 900, batchSize: 25 });

    expect(findExpiredHolds).toHaveBeenCalledWith({
      expiredBefore: new Date(NOW.getTime() - 900_000),
      limit: 25,
    });
  });

  it('reports an idle tick rather than calling finalize at all', async () => {
    const { useCase, execute } = build([]);

    expect(await useCase.execute(INPUT)).toEqual({ scanned: 0, expired: 0, raced: 0, errors: 0 });
    expect(execute).not.toHaveBeenCalled();
  });

  // The sweep and a payment can reach the same order at once; finalize's terminal guard picks the
  // winner, and losing must never look like an error.
  it.each([
    ['ignored', OrderStatus.PAID],
    ['noop', OrderStatus.EXPIRED],
  ] as const)('counts a %s finalize as raced, not failed', async (status, current) => {
    const execute = vi.fn().mockResolvedValue({ status, order: { status: current } as Order });
    const { useCase, logger } = build([hold(1)], execute);

    const summary = await useCase.execute(INPUT);

    expect(summary).toEqual({ scanned: 1, expired: 0, raced: 1, errors: 0 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: hold(1).orderId, status: current, finalize: status }),
      expect.stringContaining('no longer pending'),
    );
  });

  it('keeps sweeping the batch after one order throws', async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error('deadlock detected')).mockResolvedValue(finalized());
    const { useCase, logger } = build([hold(1), hold(2), hold(3)], execute);

    const summary = await useCase.execute(INPUT);

    expect(summary).toEqual({ scanned: 3, expired: 2, raced: 0, errors: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: hold(1).orderId }),
      expect.stringContaining('deadlock detected'),
    );
  });

  it('surfaces a failure to read the work queue instead of reporting a clean tick', async () => {
    const { useCase, findExpiredHolds } = build([]);
    findExpiredHolds.mockRejectedValue(new Error('connection terminated'));

    await expect(useCase.execute(INPUT)).rejects.toThrow('connection terminated');
  });
});
