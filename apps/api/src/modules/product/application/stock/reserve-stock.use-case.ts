import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { InsufficientStockError } from '../../domain/stock/errors/insufficient-stock.error';
import { ReservationConflictError } from '../../domain/stock/errors/reservation-conflict.error';
import {
  StockReservationError,
  type ExpiredHold,
  type ExpiredHoldQuery,
  type ProductStockReservation,
  type ReservationLine,
  type StockResolveResult,
} from '../public/product-stock-reservation.port';
import { STOCK_REPOSITORY, type LockStrategy, type StockRepositoryPort } from './ports/stock-repository.port';

/**
 * Strategy comes from `INVENTORY_LOCK_STRATEGY` (default pessimistic). Runs inside the caller's
 * `tx` so the hold commits or rolls back atomically, and translates stock's domain errors into
 * the published `StockReservationError` so cross-context callers never depend on that domain.
 */
@Injectable()
export class ReserveStockUseCase implements ProductStockReservation {
  constructor(
    @Inject(STOCK_REPOSITORY)
    private readonly stockRepo: StockRepositoryPort,
    private readonly config: ConfigService,
  ) {}

  async reserve(tx: DrizzleTx, orderId: string, lines: ReservationLine[]): Promise<void> {
    const strategy = this.config.get<LockStrategy>('inventory.lockStrategy') ?? 'pessimistic';
    try {
      if (strategy === 'optimistic') {
        await this.stockRepo.reserveOptimistic(tx, orderId, lines);
      } else {
        await this.stockRepo.reservePessimistic(tx, orderId, lines);
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

  // No shortfall path here, so no error translation: a DB CHECK violation would be a logic bug
  // and must surface rather than be masked.
  commit(tx: DrizzleTx, orderId: string): Promise<StockResolveResult> {
    return this.stockRepo.commitReservations(tx, orderId);
  }

  release(tx: DrizzleTx, orderId: string): Promise<StockResolveResult> {
    return this.stockRepo.releaseReservations(tx, orderId);
  }

  findExpiredHolds(query: ExpiredHoldQuery): Promise<ExpiredHold[]> {
    return this.stockRepo.findExpiredHolds(query);
  }
}
