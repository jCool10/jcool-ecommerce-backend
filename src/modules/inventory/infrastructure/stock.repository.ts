import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, sql } from 'drizzle-orm';
import { durationToMs } from '@shared/kernel';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import { InsufficientStockError } from '../domain/errors/insufficient-stock.error';
import { ReservationConflictError } from '../domain/errors/reservation-conflict.error';
import { ReservationStatus } from '../domain/reservation-status';
import type { ReserveLine, StockRepositoryPort, StockView } from '../application/ports/stock-repository.port';
import { reservations, stockLevels } from './schema/inventory.schema';

/**
 * Drizzle adapter for StockRepositoryPort. Pessimistic reserve locks the stock row
 * (`SELECT ... FOR UPDATE`); optimistic reserve reads without a lock and holds via a
 * version compare-and-swap with bounded retry. Both run inside the caller's `tx` so the
 * hold commits or rolls back with the order. `getStockView` is a plain read.
 */
@Injectable()
export class StockRepository implements StockRepositoryPort {
  private readonly reservationTtlMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    config: ConfigService,
  ) {
    this.reservationTtlMs = durationToMs(config.getOrThrow<string>('inventory.reservationTtl'));
    this.maxRetries = config.getOrThrow<number>('inventory.optimisticMaxRetries');
    this.backoffMs = config.getOrThrow<number>('inventory.optimisticBackoffMs');
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

  async reserveOptimistic(tx: DrizzleTx, orderId: string, lines: ReserveLine[]): Promise<void> {
    // A successful UPDATE still holds a row write-lock until the tx ends, so keep the same
    // deterministic order as the pessimistic path to rule out a cross-order deadlock.
    const ordered = [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId));
    for (const { variantId, quantity } of ordered) {
      // Idempotent for a sequential repeat of the same (order, SKU). This read isn't
      // lock-guarded (optimistic holds no row lock here), so a concurrent same-order
      // submit isn't deduped — see the port doc; callers single-flight order submission.
      const [existing] = await tx
        .select({ id: reservations.id })
        .from(reservations)
        .where(and(eq(reservations.orderId, orderId), eq(reservations.variantId, variantId)))
        .limit(1);
      if (existing) {
        continue;
      }

      await this.casReserve(tx, variantId, quantity);

      await tx
        .insert(reservations)
        .values({ orderId, variantId, quantity, status: ReservationStatus.HELD, expiresAt: this.computeExpiry() })
        .onConflictDoNothing({ target: [reservations.orderId, reservations.variantId] });
    }
  }

  // Hold one SKU via compare-and-swap: read the current version unlocked, then UPDATE only
  // if that version and the available quantity still hold. Zero rows means either a real
  // shortfall (throw, no retry) or a concurrent version bump (retry with backoff+jitter).
  private async casReserve(tx: DrizzleTx, variantId: string, quantity: number): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const [row] = await tx
        .select({
          id: stockLevels.id,
          onHand: stockLevels.quantityOnHand,
          reserved: stockLevels.quantityReserved,
          version: stockLevels.version,
        })
        .from(stockLevels)
        .where(eq(stockLevels.variantId, variantId));
      if (!row) {
        throw new InsufficientStockError(variantId, quantity, 0);
      }

      const won = await tx
        .update(stockLevels)
        .set({
          quantityReserved: sql`${stockLevels.quantityReserved} + ${quantity}`,
          version: sql`${stockLevels.version} + 1`,
        })
        .where(
          and(
            eq(stockLevels.id, row.id),
            eq(stockLevels.version, row.version),
            sql`${stockLevels.quantityOnHand} - ${stockLevels.quantityReserved} >= ${quantity}`,
          ),
        )
        .returning({ id: stockLevels.id });
      if (won.length === 1) {
        return;
      }

      const [fresh] = await tx
        .select({ onHand: stockLevels.quantityOnHand, reserved: stockLevels.quantityReserved })
        .from(stockLevels)
        .where(eq(stockLevels.id, row.id));
      if (!fresh) {
        throw new InsufficientStockError(variantId, quantity, 0);
      }
      const available = fresh.onHand - fresh.reserved;
      if (available < quantity) {
        throw new InsufficientStockError(variantId, quantity, available);
      }
      if (attempt >= this.maxRetries) {
        throw new ReservationConflictError(variantId);
      }
      await this.sleep(this.backoffMs * 2 ** attempt + this.jitter());
    }
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Random spread on the backoff so contending retries don't resynchronize into a storm.
  private jitter(): number {
    return Math.random() * this.backoffMs;
  }
}
