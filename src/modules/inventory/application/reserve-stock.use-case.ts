import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { InsufficientStockError } from '../domain/errors/insufficient-stock.error';
import { ReservationConflictError } from '../domain/errors/reservation-conflict.error';
import { STOCK_REPOSITORY, type ReserveLine, type StockRepositoryPort } from './ports/stock-repository.port';
import { StockReservationError, type StockReservation, type StockResolveResult } from './public/stock-reservation.port';

/** The two concurrency-control strategies, selected by config. */
export type LockStrategy = 'pessimistic' | 'optimistic';

/**
 * Reserve stock for an order's lines using the configured locking strategy
 * (`INVENTORY_LOCK_STRATEGY`, default pessimistic). One entry point for both
 * mechanisms behind a single port, so the caller is identical either way. Runs
 * inside the caller's `tx` so the hold commits or rolls back atomically. Implements
 * the published `StockReservation`: domain errors are translated to the published
 * `StockReservationError` so cross-context callers never depend on Inventory's domain.
 */
@Injectable()
export class ReserveStockUseCase implements StockReservation {
  constructor(
    @Inject(STOCK_REPOSITORY)
    private readonly stock: StockRepositoryPort,
    private readonly config: ConfigService,
  ) {}

  async reserve(tx: DrizzleTx, orderId: string, lines: ReserveLine[]): Promise<void> {
    const strategy = this.config.get<LockStrategy>('inventory.lockStrategy') ?? 'pessimistic';
    try {
      if (strategy === 'optimistic') {
        await this.stock.reserveOptimistic(tx, orderId, lines);
      } else {
        await this.stock.reservePessimistic(tx, orderId, lines);
      }
    } catch (error) {
      if (error instanceof InsufficientStockError) {
        throw new StockReservationError(error.message, 'OUT_OF_STOCK');
      }
      if (error instanceof ReservationConflictError) {
        throw new StockReservationError(error.message, 'CONTENDED');
      }
      throw error;
    }
  }

  // commit/release only move stock down a resolved reservation; no shortfall path, so no error
  // translation — a DB CHECK violation here would signal a logic bug and must surface, not be masked.
  commit(tx: DrizzleTx, orderId: string): Promise<StockResolveResult> {
    return this.stock.commitReservations(tx, orderId);
  }

  release(tx: DrizzleTx, orderId: string): Promise<StockResolveResult> {
    return this.stock.releaseReservations(tx, orderId);
  }
}
