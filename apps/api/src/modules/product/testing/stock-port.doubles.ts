import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type {
  ReservationOrderHeader,
  StockRepositoryPort,
  StockResolveResult,
} from '../application/stock/ports/stock-repository.port';
import type { ReservationOrderStatus } from '../domain/stock/reservation-order-status';

export const FAKE_TX = {} as DrizzleTx;

const NOTHING_RESOLVED: StockResolveResult = { applied: false, alreadyResolved: false, count: 0 };

/** Runs `transaction` inline on `FAKE_TX`; headers live in `headers`. Rollback is not modelled. */
export function fakeStockRepository(
  overrides: Partial<StockRepositoryPort> = {},
  headers = new Map<string, ReservationOrderHeader>(),
): StockRepositoryPort {
  return {
    transaction: (work) => work(FAKE_TX),
    reservePessimistic: () => Promise.resolve(),
    reserveOptimistic: () => Promise.resolve(),
    commitReservations: () => Promise.resolve(NOTHING_RESOLVED),
    releaseReservations: () => Promise.resolve(NOTHING_RESOLVED),
    restockReservations: () => Promise.resolve(NOTHING_RESOLVED),
    findExpiredHolds: () => Promise.resolve([]),
    insertHeader: (_tx, header) => {
      if (headers.has(header.orderId)) return Promise.resolve(false);
      headers.set(header.orderId, header);
      return Promise.resolve(true);
    },
    findHeaderForUpdate: (_tx, orderId) => Promise.resolve(headers.get(orderId) ?? null),
    updateHeader: (_tx, orderId, status: ReservationOrderStatus) => {
      const current = headers.get(orderId);
      if (current) headers.set(orderId, { ...current, status });
      return Promise.resolve();
    },
    findLapsedHeaders: () => Promise.resolve([]),
    ...overrides,
  };
}
