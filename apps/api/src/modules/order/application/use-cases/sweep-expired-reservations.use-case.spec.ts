import { describe, expect, it, vi } from 'vitest';
import { OrderStatus } from '../../domain/order-status';
import type { Order } from '../../domain/order.entity';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { useFakeClock } from '@jcool/testing/fake-clock';
import type { ExpiredHold, InventoryReservationPort } from '../ports/inventory-reservation.port';
import type { FinalizeOrderUseCase } from './finalize-order.use-case';
import { SweepExpiredReservationsUseCase } from './sweep-expired-reservations.use-case';

const INPUT = { graceSec: 900, batchSize: 50 };
const NOW = new Date('2026-08-27T12:00:00.000Z');

function hold(n: number): ExpiredHold {
  return {
    orderId: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${n}`,
    expiresAt: new Date(NOW.getTime() - 30 * 60_000),
  };
}

function build(holds: ExpiredHold[], execute = vi.fn()) {
  const findExpiredHolds = vi.fn().mockResolvedValue(holds);
  const metrics = fakeMetricsPort();
  const useCase = new SweepExpiredReservationsUseCase(
    { findExpiredHolds } as unknown as InventoryReservationPort,
    { execute } as unknown as FinalizeOrderUseCase,
    metrics,
    fakePinoLogger(),
  );
  return { useCase, findExpiredHolds, execute, metrics };
}

describe('SweepExpiredReservationsUseCase', () => {
  useFakeClock(NOW);

  it('expires what it can, counts lost races apart from errors, and finishes the batch', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: 'finalized', order: { status: OrderStatus.EXPIRED } as Order })
      .mockResolvedValueOnce({ status: 'ignored', order: { status: OrderStatus.PAID } as Order })
      .mockResolvedValueOnce({ status: 'noop', order: { status: OrderStatus.EXPIRED } as Order })
      .mockRejectedValueOnce(new Error('deadlock detected'));
    const holds = [hold(1), hold(2), hold(3), hold(4)];
    const { useCase, metrics } = build(holds, execute);

    const summary = await useCase.execute(INPUT);

    expect(summary).toEqual({ scanned: 4, expired: 1, raced: 2, errors: 1 });
    expect(execute.mock.calls.map(([input]: unknown[]) => input)).toEqual(
      holds.map(({ orderId }) => ({ orderId, outcome: OrderStatus.EXPIRED, reason: 'ttl:expired' })),
    );
    expect(metrics.recordReservationExpiry).toHaveBeenCalledOnce();
  });

  it('surfaces a failure to read the work queue instead of reporting a clean tick', async () => {
    const { useCase, findExpiredHolds } = build([]);
    findExpiredHolds.mockRejectedValue(new Error('connection terminated'));

    await expect(useCase.execute(INPUT)).rejects.toThrow('connection terminated');
  });
});
