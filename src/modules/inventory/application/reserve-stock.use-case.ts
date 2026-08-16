import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { STOCK_REPOSITORY, type ReserveLine, type StockRepositoryPort } from './ports/stock-repository.port';

/** The two concurrency-control strategies, selected by config. */
export type LockStrategy = 'pessimistic' | 'optimistic';

/**
 * Reserve stock for an order's lines using the configured locking strategy
 * (`INVENTORY_LOCK_STRATEGY`, default pessimistic). One entry point for both
 * mechanisms behind a single port, so the caller is identical either way. Runs
 * inside the caller's `tx` so the hold commits or rolls back atomically.
 */
@Injectable()
export class ReserveStockUseCase {
  constructor(
    @Inject(STOCK_REPOSITORY)
    private readonly stock: StockRepositoryPort,
    private readonly config: ConfigService,
  ) {}

  async reserve(tx: DrizzleTx, orderId: string, lines: ReserveLine[]): Promise<void> {
    const strategy = this.config.get<LockStrategy>('inventory.lockStrategy') ?? 'pessimistic';
    if (strategy === 'optimistic') {
      return this.stock.reserveOptimistic(tx, orderId, lines);
    }
    return this.stock.reservePessimistic(tx, orderId, lines);
  }
}
