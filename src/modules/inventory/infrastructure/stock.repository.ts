import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { durationToMs } from '@shared/kernel';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import { InsufficientStockError } from '../domain/errors/insufficient-stock.error';
import { ReservationConflictError } from '../domain/errors/reservation-conflict.error';
import { ReservationStatus } from '../domain/reservation-status';
import type {
  ExpiredHold,
  ExpiredHoldQuery,
  ReserveLine,
  StockRepositoryPort,
  StockResolveResult,
  StockView,
} from '../application/ports/stock-repository.port';
import { reservations, stockLevels } from './schema/inventory.schema';

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

  async commitReservations(tx: DrizzleTx, orderId: string): Promise<StockResolveResult> {
    return this.resolveReservations(tx, orderId, ReservationStatus.COMMITTED);
  }

  async releaseReservations(tx: DrizzleTx, orderId: string): Promise<StockResolveResult> {
    return this.resolveReservations(tx, orderId, ReservationStatus.RELEASED);
  }

  // The per-line UPDATE locks the shared stock rows in the SAME order the reserve path uses —
  // `variantId` ascending — so two orders touching overlapping SKUs cannot deadlock. Each flip is a
  // CAS on status='HELD', so a duplicate resolve moves the stock delta exactly once.
  private async resolveReservations(
    tx: DrizzleTx,
    orderId: string,
    target: typeof ReservationStatus.COMMITTED | typeof ReservationStatus.RELEASED,
  ): Promise<StockResolveResult> {
    const rows = await tx
      .select({ variantId: reservations.variantId, quantity: reservations.quantity, status: reservations.status })
      .from(reservations)
      .where(eq(reservations.orderId, orderId));

    if (rows.length === 0) {
      return { applied: false, alreadyResolved: false, count: 0 };
    }
    // Sort in JS with the exact comparator reservePessimistic/reserveOptimistic use, so the lock order is
    // identical to reserve regardless of DB collation (not the SQL sort, which may order UUIDs differently).
    const held = rows
      .filter((r) => r.status === ReservationStatus.HELD)
      .sort((a, b) => a.variantId.localeCompare(b.variantId));
    if (held.length === 0) {
      return { applied: false, alreadyResolved: true, count: 0 };
    }

    let count = 0;
    for (const { variantId, quantity } of held) {
      const flipped = await tx
        .update(reservations)
        .set({ status: target })
        .where(
          and(
            eq(reservations.orderId, orderId),
            eq(reservations.variantId, variantId),
            eq(reservations.status, ReservationStatus.HELD),
          ),
        )
        .returning({ id: reservations.id });
      if (flipped.length === 0) {
        continue;
      }

      const setStock =
        target === ReservationStatus.COMMITTED
          ? {
              quantityOnHand: sql`${stockLevels.quantityOnHand} - ${quantity}`,
              quantityReserved: sql`${stockLevels.quantityReserved} - ${quantity}`,
              version: sql`${stockLevels.version} + 1`,
            }
          : {
              quantityReserved: sql`${stockLevels.quantityReserved} - ${quantity}`,
              version: sql`${stockLevels.version} + 1`,
            };
      await tx.update(stockLevels).set(setStock).where(eq(stockLevels.variantId, variantId));
      count += 1;
    }

    // Every held row lost the CAS to a concurrent resolver → nothing for us to apply.
    if (count === 0) {
      return { applied: false, alreadyResolved: true, count: 0 };
    }
    return { applied: true, alreadyResolved: false, count };
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

  async findExpiredHolds({ expiredBefore, limit }: ExpiredHoldQuery): Promise<ExpiredHold[]> {
    // `SKIP LOCKED` steps over holds a finalize is already resolving instead of queueing behind its
    // row lock; the lock itself lasts only this statement, so it dedupes nothing beyond that — the
    // caller's terminal guard is what makes two sweeps picking the same order harmless.
    const rows = await this.db
      .select({ orderId: reservations.orderId, expiresAt: reservations.expiresAt })
      .from(reservations)
      .where(and(eq(reservations.status, ReservationStatus.HELD), lt(reservations.expiresAt, expiredBefore)))
      .orderBy(asc(reservations.expiresAt))
      .limit(limit)
      .for('update', { skipLocked: true });

    // An order's lines each carry their own row, so collapse them: the caller acts per order, and a
    // wide order must not spend the whole batch. `expires_at < :t` already dropped NULLs.
    const earliest = new Map<string, Date>();
    for (const row of rows) {
      const expiresAt = row.expiresAt as Date;
      const seen = earliest.get(row.orderId);
      if (seen === undefined || expiresAt < seen) {
        earliest.set(row.orderId, expiresAt);
      }
    }
    return [...earliest].map(([orderId, expiresAt]) => ({ orderId, expiresAt }));
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
