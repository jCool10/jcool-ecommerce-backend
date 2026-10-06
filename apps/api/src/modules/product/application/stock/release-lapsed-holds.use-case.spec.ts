import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { ReservationTimeoutError } from '../../domain/stock/errors/reservation-timeout.error';
import type { ReservationOrderStatus } from '../../domain/stock/reservation-order-status';
import { FAKE_TX, fakeStockRepository } from '../../testing/stock-port.doubles';
import type { ReservationOrderHeader, StockRepositoryPort } from './ports/stock-repository.port';
import { ReleaseLapsedHoldsUseCase } from './release-lapsed-holds.use-case';

const NOW = new Date('2026-10-05T12:00:00Z');
const LAPSED = new Date('2026-10-05T11:00:00Z');
const TX_TIMEOUT_MS = 1500;

function build(seed: Record<string, ReservationOrderStatus>, overrides: Partial<StockRepositoryPort> = {}) {
  const headers = new Map<string, ReservationOrderHeader>(
    Object.entries(seed).map(([orderId, status]) => [orderId, { orderId, status, holdUntil: LAPSED }]),
  );
  const findLapsedHeaders = vi.fn<StockRepositoryPort['findLapsedHeaders']>(() =>
    Promise.resolve(Object.keys(seed).map((orderId) => ({ orderId, holdUntil: LAPSED }))),
  );
  const stock = fakeStockRepository({ findLapsedHeaders, ...overrides }, headers);
  const transaction = vi.spyOn(stock, 'transaction');
  const releaseReservations = vi.spyOn(stock, 'releaseReservations');
  const metrics = fakeMetricsPort();
  const logger = { warn: vi.fn() };
  const useCase = new ReleaseLapsedHoldsUseCase(
    stock,
    fakeConfigService({ 'inventory.tryLockTimeoutMs': TX_TIMEOUT_MS }),
    metrics,
    fakePinoLogger(logger),
  );
  return { useCase, headers, findLapsedHeaders, transaction, releaseReservations, metrics, logger };
}

describe('ReleaseLapsedHoldsUseCase', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases every lapsed hold in the batch, lines and header together', async () => {
    const { useCase, headers, findLapsedHeaders, releaseReservations, metrics } = build({ a: 'HELD', b: 'HELD' });

    expect(await useCase.execute({ batchSize: 50 })).toEqual({ scanned: 2, released: 2, raced: 0, errors: 0 });

    expect(findLapsedHeaders).toHaveBeenCalledWith({ lapsedBefore: NOW, limit: 50 });
    expect(releaseReservations.mock.calls).toEqual([
      [FAKE_TX, 'a'],
      [FAKE_TX, 'b'],
    ]);
    expect([...headers.values()].map((h) => h.status)).toEqual(['RELEASED', 'RELEASED']);
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'sweep', 'ok');
  });

  it('counts a hold resolved since the claim as raced and leaves it alone', async () => {
    const { useCase, headers, releaseReservations, metrics } = build({ committed: 'COMMITTED', released: 'RELEASED' });

    expect(await useCase.execute({ batchSize: 50 })).toEqual({ scanned: 2, released: 0, raced: 2, errors: 0 });

    expect(releaseReservations).not.toHaveBeenCalled();
    expect(headers.get('committed')?.status).toBe('COMMITTED');
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'sweep', 'conflict');
  });

  it('isolates a failing order from the rest of the batch', async () => {
    const fault = new Error('deadlock detected');
    const { useCase, headers, metrics, logger } = build(
      { broken: 'HELD', fine: 'HELD' },
      {
        releaseReservations: (_tx, orderId) =>
          orderId === 'broken'
            ? Promise.reject(fault)
            : Promise.resolve({ applied: true, alreadyResolved: false, count: 1 }),
      },
    );

    expect(await useCase.execute({ batchSize: 50 })).toEqual({ scanned: 2, released: 1, raced: 0, errors: 1 });

    expect(headers.get('fine')?.status).toBe('RELEASED');
    expect(metrics.recordTccBranch).toHaveBeenCalledWith('inventory', 'sweep', 'error');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'broken', err: fault }),
      expect.any(String),
    );
  });

  it("bounds each order's transaction by the participant's time budget", async () => {
    const { useCase, transaction } = build({ a: 'HELD', b: 'HELD' });

    await useCase.execute({ batchSize: 50 });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenNthCalledWith(1, expect.any(Function), { timeoutMs: TX_TIMEOUT_MS });
    expect(transaction).toHaveBeenNthCalledWith(2, expect.any(Function), { timeoutMs: TX_TIMEOUT_MS });
  });

  it('leaves a hold whose release ran out of time HELD for the next tick', async () => {
    const { useCase, headers } = build(
      { slow: 'HELD', fine: 'HELD' },
      {
        releaseReservations: (_tx, orderId) =>
          orderId === 'slow'
            ? Promise.reject(new ReservationTimeoutError(TX_TIMEOUT_MS))
            : Promise.resolve({ applied: true, alreadyResolved: false, count: 1 }),
      },
    );

    expect(await useCase.execute({ batchSize: 50 })).toEqual({ scanned: 2, released: 1, raced: 0, errors: 1 });

    expect(headers.get('slow')?.status).toBe('HELD');
    expect(headers.get('fine')?.status).toBe('RELEASED');
  });
});
