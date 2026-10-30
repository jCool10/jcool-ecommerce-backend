import type { DrizzleTx } from '../../../database';
import type { StockRepositoryPort } from '../application/ports/stock-repository.port';

export const FAKE_TX = {} as DrizzleTx;

const NOTHING_RESOLVED = { applied: false, alreadyResolved: false, count: 0 };

/** Whole-port double: `transaction` runs the work on `FAKE_TX`, every other method answers empty. */
export function fakeStockRepository(overrides: Partial<StockRepositoryPort> = {}): StockRepositoryPort {
  return {
    transaction: (work) => work(FAKE_TX),
    reservePessimistic: () => Promise.resolve(),
    reserveOptimistic: () => Promise.resolve(),
    commitReservations: () => Promise.resolve(NOTHING_RESOLVED),
    releaseReservations: () => Promise.resolve(NOTHING_RESOLVED),
    restockReservations: () => Promise.resolve(NOTHING_RESOLVED),
    insertHeader: () => Promise.resolve(true),
    insertFencedHeader: () => Promise.resolve(true),
    findHeaderForUpdate: () => Promise.resolve(null),
    lockLapsedHeader: () => Promise.resolve(true),
    setHeaderStatus: () => Promise.resolve(),
    findLapsedHeaderIds: () => Promise.resolve([]),
    findHeaderStatuses: () => Promise.resolve(new Map()),
    ...overrides,
  };
}
