import { Inject, Injectable, NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, sql } from 'drizzle-orm';
import { durationToMs } from '@shared/kernel';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import { InsufficientStockError } from '../domain/errors/insufficient-stock.error';
import { ReservationStatus } from '../domain/reservation-status';
import type { ReserveLine, StockRepositoryPort, StockView } from '../application/ports/stock-repository.port';
import { reservations, stockLevels } from './schema/inventory.schema';

/**
 * Drizzle adapter for StockRepositoryPort. Pessimistic reserve locks the stock row
 * (`SELECT ... FOR UPDATE`) inside the caller's `tx` so the hold commits or rolls back
 * with the order; optimistic reserve is still a seam. `getStockView` is a plain read.
 */
@Injectable()
export class StockRepository implements StockRepositoryPort {
  private readonly reservationTtlMs: number;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    config: ConfigService,
  ) {
    this.reservationTtlMs = durationToMs(config.getOrThrow<string>('inventory.reservationTtl'));
  }

  async reservePessimistic(tx: DrizzleTx, orderId: string, lines: ReserveLine[]): Promise<void> {
    // Lock rows in a deterministic order so two orders holding the same SKUs can't deadlock.
    const ordered = [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId));
    for (const { variantId, quantity } of ordered) {
      const [stock] = await tx.select().from(stockLevels).where(eq(stockLevels.variantId, variantId)).for('update');
      if (!stock) {
        throw new InsufficientStockError(variantId, quantity, 0);
      }

      // Idempotent per (order, SKU): a repeat hold must not raise reserved twice. Checked
      // under the row lock, so a concurrent duplicate serializes here and sees this hold.
      const [existing] = await tx
        .select({ id: reservations.id })
        .from(reservations)
        .where(and(eq(reservations.orderId, orderId), eq(reservations.variantId, variantId)))
        .limit(1);
      if (existing) {
        continue;
      }

      const available = stock.quantityOnHand - stock.quantityReserved;
      if (available < quantity) {
        throw new InsufficientStockError(variantId, quantity, available);
      }

      await tx
        .update(stockLevels)
        .set({
          quantityReserved: sql`${stockLevels.quantityReserved} + ${quantity}`,
          version: sql`${stockLevels.version} + 1`,
        })
        .where(eq(stockLevels.id, stock.id));

      await tx
        .insert(reservations)
        .values({ orderId, variantId, quantity, status: ReservationStatus.HELD, expiresAt: this.computeExpiry() })
        .onConflictDoNothing({ target: [reservations.orderId, reservations.variantId] });
    }
  }

  reserveOptimistic(_tx: DrizzleTx, _orderId: string, _lines: ReserveLine[]): Promise<void> {
    throw new NotImplementedException('Optimistic reserve not yet implemented');
  }

  async getStockView(variantId: string): Promise<StockView | null> {
    const [row] = await this.db
      .select({ onHand: stockLevels.quantityOnHand, reserved: stockLevels.quantityReserved })
      .from(stockLevels)
      .where(eq(stockLevels.variantId, variantId))
      .limit(1);
    if (!row) {
      return null;
    }
    return { onHand: row.onHand, reserved: row.reserved, available: row.onHand - row.reserved };
  }

  private computeExpiry(): Date {
    return new Date(Date.now() + this.reservationTtlMs);
  }
}
