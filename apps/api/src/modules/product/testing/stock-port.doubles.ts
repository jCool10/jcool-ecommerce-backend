import { vi, type Mock } from 'vitest';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type { StockRepositoryPort, StockResolveResult } from '../application/stock/ports/stock-repository.port';

export const FAKE_TX = {} as DrizzleTx;

// The intersection keeps `transaction` generic; a bare Mock<> would pin its T to unknown.
export type FakeStockRepository = {
  [K in keyof StockRepositoryPort]: StockRepositoryPort[K] & Mock<StockRepositoryPort[K]>;
};

const NOTHING_RESOLVED: StockResolveResult = { applied: false, alreadyResolved: false, count: 0 };

/** Answers as if the order had no rows at all; `transaction` runs the work on `FAKE_TX`. Every method is a spy. */
export function fakeStockRepository(overrides: Partial<StockRepositoryPort> = {}): FakeStockRepository {
  const port: StockRepositoryPort = {
    transaction: (work) => work(FAKE_TX),
    reservePessimistic: () => Promise.resolve(),
    reserveOptimistic: () => Promise.resolve(),
    commitReservations: () => Promise.resolve(NOTHING_RESOLVED),
    releaseReservations: () => Promise.resolve(NOTHING_RESOLVED),
    restockReservations: () => Promise.resolve(NOTHING_RESOLVED),
    findExpiredHolds: () => Promise.resolve([]),
    insertHeader: () => Promise.resolve(true),
    findHeaderForUpdate: () => Promise.resolve(null),
    updateHeader: () => Promise.resolve(),
    findLapsedHeaders: () => Promise.resolve([]),
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(port).map(([name, impl]) => [name, vi.isMockFunction(impl) ? impl : vi.fn(impl)]),
  ) as FakeStockRepository;
}
