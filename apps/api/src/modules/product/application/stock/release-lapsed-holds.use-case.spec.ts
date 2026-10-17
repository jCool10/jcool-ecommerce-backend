import { describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { useFakeClock } from '@jcool/testing/fake-clock';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { ReservationTimeoutError } from '../../domain/stock/errors/reservation-timeout.error';
import type { ReservationOrderStatus } from '../../domain/stock/reservation-order-status';
import { FAKE_TX, fakeStockRepository } from '../../testing/stock-port.doubles';
import type { StockRepositoryPort } from './ports/stock-repository.port';
import { ReleaseLapsedHoldsUseCase } from './release-lapsed-holds.use-case';

const NOW = new Date('2026-10-17T08:00:00Z');
const LAPSED_AT = new Date('2026-10-17T07:00:00Z');
const BUDGET_MS = 2_000;

function build(statuses: Record<string, ReservationOrderStatus | Error>, overrides: Partial<StockRepositoryPort> = {}) {
  const repo = fakeStockRepository({
    findLapsedHeaders: () =>
      Promise.resolve(Object.keys(statuses).map((orderId) => ({ orderId, holdUntil: LAPSED_AT }))),
    findHeaderForUpdate: (_tx, orderId) => {
      const status = statuses[orderId];
      return status instanceof Error
        ? Promise.reject(status)
        : Promise.resolve({ orderId, status, holdUntil: LAPSED_AT });
    },
    releaseReservations: () => Promise.resolve({ applied: true, alreadyResolved: false, count: 1 }),
    ...overrides,
  });
  const metrics = fakeMetricsPort();
  const warn = vi.fn();
  const useCase = new ReleaseLapsedHoldsUseCase(
    repo,
    fakeConfigService({ 'inventory.tryLockTimeoutMs': BUDGET_MS }),
    metrics,
    fakePinoLogger({ warn }),
  );
  return { useCase, repo, metrics, warn };
}

describe('ReleaseLapsedHoldsUseCase', () => {
  useFakeClock(NOW);

  it('reads the oldest lapsed headers up to the batch size', async () => {
    const { useCase, repo } = build({});

    await useCase.execute({ batchSize: 25 });

    expect(repo.findLapsedHeaders).toHaveBeenCalledWith({ lapsedBefore: NOW, limit: 25 });
  });

  it('releases the stock of every lapsed order that is still held', async () => {
    const { useCase, repo, metrics } = build({ 'order-1': 'HELD', 'order-2': 'HELD' });

    await expect(useCase.execute({ batchSize: 50 })).resolves.toEqual({
      scanned: 2,
      released: 2,
      raced: 0,
      errors: 0,
    });

    expect(repo.releaseReservations).toHaveBeenCalledWith(FAKE_TX, 'order-2');
    expect(repo.updateHeader).toHaveBeenCalledWith(FAKE_TX, 'order-2', 'RELEASED');
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'sweep', 'ok');
  });

  it('counts an order resolved after the read as raced, not as a failure', async () => {
    const { useCase, repo, metrics } = build({ 'order-1': 'COMMITTED' });

    await expect(useCase.execute({ batchSize: 50 })).resolves.toMatchObject({ raced: 1, errors: 0 });

    expect(repo.releaseReservations).not.toHaveBeenCalled();
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'sweep', 'conflict');
  });

  it('keeps going past an order that fails', async () => {
    const { useCase, metrics, warn } = build({ 'order-1': new Error('connection reset'), 'order-2': 'HELD' });

    await expect(useCase.execute({ batchSize: 50 })).resolves.toMatchObject({ released: 1, errors: 1 });

    expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'sweep', 'error');
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'order-1' }), expect.any(String));
  });

  it('bounds each order by the Try budget and leaves a timed-out one held for the next tick', async () => {
    const { useCase, repo } = build({ 'order-1': new ReservationTimeoutError(BUDGET_MS) });

    await expect(useCase.execute({ batchSize: 50 })).resolves.toMatchObject({ released: 0, errors: 1 });

    expect(repo.transaction).toHaveBeenCalledWith(expect.any(Function), { timeoutMs: BUDGET_MS });
    expect(repo.updateHeader).not.toHaveBeenCalled();
  });
});
