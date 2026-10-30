import { describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { useFakeClock } from '@jcool/testing/fake-clock';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { DrizzleTx } from '../../../database';
import { ReservationTimeoutError } from '../domain/errors/reservation-timeout.error';
import { FAKE_TX, fakeStockRepository } from '../testing/stock-port.doubles';
import type { StockRepositoryPort, StockTransactionOptions } from './ports/stock-repository.port';
import { ReleaseLapsedHoldsUseCase } from './release-lapsed-holds.use-case';

const NOW = new Date('2026-10-20T10:00:00.000Z');
const BUDGET_MS = 2_000;

function build(repo: Partial<StockRepositoryPort>) {
  const transaction = vi.fn((work: (tx: DrizzleTx) => Promise<unknown>, _options?: StockTransactionOptions) =>
    work(FAKE_TX),
  );
  const metrics = fakeMetricsPort();
  const warn = vi.fn();
  const useCase = new ReleaseLapsedHoldsUseCase(
    fakeStockRepository({ transaction: transaction as StockRepositoryPort['transaction'], ...repo }),
    metrics,
    fakeConfigService({ 'inventory.tryLockTimeoutMs': BUDGET_MS }),
    fakePinoLogger({ warn }),
  );
  return { useCase, transaction, metrics, warn };
}

describe('ReleaseLapsedHoldsUseCase', () => {
  useFakeClock(NOW);

  it('releases the lines and the header of every lapsed order it still finds HELD', async () => {
    const releaseReservations = vi.fn().mockResolvedValue({ applied: true, alreadyResolved: false, count: 1 });
    const setHeaderStatus = vi.fn().mockResolvedValue(undefined);
    const findLapsedHeaderIds = vi.fn().mockResolvedValue(['1', '2']);
    const { useCase, metrics } = build({ findLapsedHeaderIds, releaseReservations, setHeaderStatus });

    const summary = await useCase.execute({ batchSize: 50 });

    expect(summary).toEqual({ scanned: 2, released: 2, raced: 0, errors: 0 });
    expect(findLapsedHeaderIds).toHaveBeenCalledWith({ limit: 50 });
    expect(releaseReservations.mock.calls).toEqual([
      [FAKE_TX, '1'],
      [FAKE_TX, '2'],
    ]);
    expect(setHeaderStatus.mock.calls).toEqual([
      [FAKE_TX, '1', 'RELEASED'],
      [FAKE_TX, '2', 'RELEASED'],
    ]);
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'lapse_release', 'applied');
  });

  // Committed, released or locked by a command between the read and this lock: someone else's to settle.
  it('counts a header it can no longer lock as raced and leaves it alone', async () => {
    const releaseReservations = vi.fn();
    const { useCase } = build({
      findLapsedHeaderIds: () => Promise.resolve(['1']),
      lockLapsedHeader: () => Promise.resolve(false),
      releaseReservations,
    });

    expect(await useCase.execute({ batchSize: 50 })).toEqual({ scanned: 1, released: 0, raced: 1, errors: 0 });
    expect(releaseReservations).not.toHaveBeenCalled();
  });

  it('isolates one failing order from the rest of the batch', async () => {
    const releaseReservations = vi
      .fn()
      .mockRejectedValueOnce(new ReservationTimeoutError())
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockResolvedValue({ applied: true, alreadyResolved: false, count: 1 });
    const { useCase, metrics, warn } = build({
      findLapsedHeaderIds: () => Promise.resolve(['1', '2', '3']),
      releaseReservations,
    });

    expect(await useCase.execute({ batchSize: 50 })).toEqual({ scanned: 3, released: 1, raced: 0, errors: 2 });
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'lapse_release', 'error');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('gives every order its own transaction under a deadline of now + budget', async () => {
    const { useCase, transaction } = build({ findLapsedHeaderIds: () => Promise.resolve(['1', '2']) });

    await useCase.execute({ batchSize: 50 });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { deadline: NOW.getTime() + BUDGET_MS });
  });

  it('surfaces a failure to read the candidates instead of reporting a clean tick', async () => {
    const { useCase } = build({ findLapsedHeaderIds: () => Promise.reject(new Error('connection terminated')) });

    await expect(useCase.execute({ batchSize: 50 })).rejects.toThrow('connection terminated');
  });
});
