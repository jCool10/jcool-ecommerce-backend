import { describe, expect, it, vi } from 'vitest';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { InsufficientStockError } from '../domain/errors/insufficient-stock.error';
import { ReservationConflictError } from '../domain/errors/reservation-conflict.error';
import { StockReservationError } from './public/stock-reservation.port';
import { ReserveStockUseCase } from './reserve-stock.use-case';

const TX = {} as DrizzleTx;
const LINES = [{ variantId: 'sku-a', quantity: 1 }];
const RESOLVED = { applied: true, alreadyResolved: false, count: 1 };

function build(strategy: string | undefined, reserveError?: Error) {
  const reserve = () => (reserveError ? Promise.reject(reserveError) : Promise.resolve());
  const reservePessimistic = vi.fn(reserve);
  const reserveOptimistic = vi.fn(reserve);
  const useCase = new ReserveStockUseCase(
    {
      reservePessimistic,
      reserveOptimistic,
      commitReservations: () => Promise.resolve(RESOLVED),
      releaseReservations: () => Promise.resolve(RESOLVED),
      findExpiredHolds: () => Promise.resolve([]),
    },
    fakeConfigService({ 'inventory.lockStrategy': strategy }),
  );
  return { useCase, reservePessimistic, reserveOptimistic };
}

describe('ReserveStockUseCase', () => {
  it('holds pessimistically unless the strategy is optimistic', async () => {
    const unset = build(undefined);
    const optimistic = build('optimistic');

    await unset.useCase.reserve(TX, 'order-1', LINES);
    await optimistic.useCase.reserve(TX, 'order-1', LINES);

    expect(unset.reservePessimistic).toHaveBeenCalledWith(TX, 'order-1', LINES);
    expect(unset.reserveOptimistic).not.toHaveBeenCalled();
    expect(optimistic.reserveOptimistic).toHaveBeenCalledWith(TX, 'order-1', LINES);
    expect(optimistic.reservePessimistic).not.toHaveBeenCalled();
  });

  // Callers map the reason: OUT_OF_STOCK is a hard sold-out, CONTENDED a conflict worth retrying.
  it('maps stock errors to OUT_OF_STOCK or CONTENDED and rethrows the rest', async () => {
    const outcomeOf = async (error: Error): Promise<unknown> => {
      const failure = await build('optimistic', error)
        .useCase.reserve(TX, 'order-1', LINES)
        .catch((caught: unknown) => caught);
      return failure instanceof StockReservationError ? failure.reason : failure;
    };
    const unexpected = new Error('db down');

    expect(await outcomeOf(new InsufficientStockError('sku-a', 1, 0))).toBe('OUT_OF_STOCK');
    expect(await outcomeOf(new ReservationConflictError('sku-a'))).toBe('CONTENDED');
    expect(await outcomeOf(unexpected)).toBe(unexpected);
  });
});
