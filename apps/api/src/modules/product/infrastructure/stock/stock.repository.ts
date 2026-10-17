import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, lt, notExists, sql } from 'drizzle-orm';
import { durationToMs } from '@jcool/kernel';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import { ID_GENERATOR, type IdGeneratorPort } from '@shared/identity/id-generator.port';
import { InsufficientStockError } from '../../domain/stock/errors/insufficient-stock.error';
import { ReservationConflictError } from '../../domain/stock/errors/reservation-conflict.error';
import { ReservationOrderStatus } from '../../domain/stock/reservation-order-status';
import { ReservationStatus } from '../../domain/stock/reservation-status';
import type {
  ExpiredHold,
  ExpiredHoldQuery,
  HoldOptions,
  LapsedHeader,
  LapsedHeaderQuery,
  ReservationLine,
  ReservationOrderHeader,
  StockRepositoryPort,
  StockResolveResult,
  StockTransactionOptions,
} from '../../application/stock/ports/stock-repository.port';
import { BoundedTransactions } from './bounded-transactions';
import { reservationOrders, reservations, stockLevels } from './schema/stock.schema';

type LineTarget =
  typeof ReservationStatus.COMMITTED | typeof ReservationStatus.RELEASED | typeof ReservationStatus.RESTOCKED;

// Per-unit deltas. None raises `reserved` or drops on-hand on its own, so none can trip ck_stock_no_oversell.
const LINE_MOVES: Record<LineTarget, { from: ReservationStatus; onHand: number; reserved: number }> = {
  COMMITTED: { from: ReservationStatus.HELD, onHand: -1, reserved: -1 },
  RELEASED: { from: ReservationStatus.HELD, onHand: 0, reserved: -1 },
  RESTOCKED: { from: ReservationStatus.COMMITTED, onHand: 1, reserved: 0 },
};

@Injectable()
export class StockRepository implements StockRepositoryPort {
  private readonly reservationTtlMs: number;
  private readonly maxRetries: number;
  private readonly bounded: BoundedTransactions;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGeneratorPort,
    config: ConfigService,
  ) {
    this.reservationTtlMs = durationToMs(config.getOrThrow<string>('inventory.reservationTtl'));
    this.maxRetries = config.getOrThrow<number>('inventory.optimisticMaxRetries');
    this.bounded = new BoundedTransactions(db);
  }

  transaction<T>(work: (tx: DrizzleTx) => Promise<T>, { timeoutMs }: StockTransactionOptions = {}): Promise<T> {
    return this.bounded.run(work, timeoutMs);
  }

  // Minted before the first stock row lock, so no checkout queues behind an id-service call.
  private mintReservationIds(lines: ReservationLine[]): Promise<string[]> {
    return this.idGenerator.mint(lines.length);
  }

  async reservePessimistic(
    tx: DrizzleTx,
    orderId: string,
    lines: ReservationLine[],
    { expiresAt, reservationIds }: HoldOptions = {},
  ): Promise<void> {
    const ids = reservationIds ?? (await this.mintReservationIds(lines));
    // Lock rows in a deterministic order so two orders holding the same SKUs can't deadlock.
    const ordered = [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId));
    for (const [index, { variantId, quantity }] of ordered.entries()) {
      await this.bounded.arm(tx);
      const [stock] = await tx.select().from(stockLevels).where(eq(stockLevels.variantId, variantId)).for('update');
      if (!stock) {
        throw new InsufficientStockError(variantId, quantity, 0);
      }

      // Idempotent per (order, SKU): a repeat hold must not raise reserved twice. Checked
      // under the row lock, so a concurrent duplicate serializes here and sees this hold.
      if (await this.isHeld(tx, orderId, variantId)) {
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

      await this.insertHold(tx, ids[index], orderId, variantId, quantity, expiresAt);
    }
  }

  async reserveOptimistic(
    tx: DrizzleTx,
    orderId: string,
    lines: ReservationLine[],
    { expiresAt, reservationIds }: HoldOptions = {},
  ): Promise<void> {
    const ids = reservationIds ?? (await this.mintReservationIds(lines));
    // A successful UPDATE still holds a row write-lock until the tx ends, so keep the same
    // deterministic order as the pessimistic path to rule out a cross-order deadlock.
    const ordered = [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId));
    for (const [index, { variantId, quantity }] of ordered.entries()) {
      if (await this.casReserve(tx, orderId, variantId, quantity)) {
        await this.insertHold(tx, ids[index], orderId, variantId, quantity, expiresAt);
      }
    }
  }

  private holdOf(tx: DrizzleTx, orderId: string, variantId: string) {
    return tx
      .select({ id: reservations.id })
      .from(reservations)
      .where(and(eq(reservations.orderId, orderId), eq(reservations.variantId, variantId)));
  }

  private async isHeld(tx: DrizzleTx, orderId: string, variantId: string): Promise<boolean> {
    const [existing] = await this.holdOf(tx, orderId, variantId).limit(1);
    return existing !== undefined;
  }

  private async insertHold(
    tx: DrizzleTx,
    id: string,
    orderId: string,
    variantId: string,
    quantity: number,
    expiresAt: Date = this.computeExpiry(),
  ): Promise<void> {
    await tx
      .insert(reservations)
      .values({ id, orderId, variantId, quantity, status: ReservationStatus.HELD, expiresAt })
      .onConflictDoNothing({ target: [reservations.orderId, reservations.variantId] });
  }

  // Hold one SKU via compare-and-swap: read the current version unlocked, then UPDATE only
  // if that version and the available quantity still hold and this (order, SKU) is still
  // unheld. Returns false, raising nothing, when a hold for it already exists.
  // The retry never backs off: under READ COMMITTED a lost CAS is only visible once the
  // conflicting writer has committed and dropped its row lock, so sleeping relieves no
  // contention while extending the write locks this transaction already holds on earlier lines.
  private async casReserve(tx: DrizzleTx, orderId: string, variantId: string, quantity: number): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      // Before the shortfall and budget checks: the writer this CAS lost to may be a duplicate of
      // this order, and the stock it took is this order's own hold, not a shortfall.
      if (await this.isHeld(tx, orderId, variantId)) {
        return false;
      }

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
      // Real shortfalls never consume a retry, so this precedes the budget check.
      const available = row.onHand - row.reserved;
      if (available < quantity) {
        throw new InsufficientStockError(variantId, quantity, available);
      }
      if (attempt > this.maxRetries) {
        throw new ReservationConflictError(variantId);
      }

      await this.bounded.arm(tx);
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
            // A duplicate that committed its hold after the isHeld read above, before this statement.
            notExists(this.holdOf(tx, orderId, variantId)),
          ),
        )
        .returning({ id: stockLevels.id });
      if (won.length === 1) {
        return true;
      }
    }
  }

  commitReservations(tx: DrizzleTx, orderId: string): Promise<StockResolveResult> {
    return this.moveLines(tx, orderId, ReservationStatus.COMMITTED);
  }

  releaseReservations(tx: DrizzleTx, orderId: string): Promise<StockResolveResult> {
    return this.moveLines(tx, orderId, ReservationStatus.RELEASED);
  }

  restockReservations(tx: DrizzleTx, orderId: string): Promise<StockResolveResult> {
    return this.moveLines(tx, orderId, ReservationStatus.RESTOCKED);
  }

  // The per-line UPDATE locks the shared stock rows in the SAME order the reserve path uses —
  // `variantId` ascending — so two orders touching overlapping SKUs cannot deadlock. Each flip is a
  // CAS on the source status, so a duplicate call moves the stock delta exactly once.
  private async moveLines(tx: DrizzleTx, orderId: string, target: LineTarget): Promise<StockResolveResult> {
    const { from, onHand, reserved } = LINE_MOVES[target];
    const rows = await tx
      .select({ variantId: reservations.variantId, quantity: reservations.quantity, status: reservations.status })
      .from(reservations)
      .where(eq(reservations.orderId, orderId));

    if (rows.length === 0) {
      return { applied: false, alreadyResolved: false, count: 0 };
    }
    // Sort in JS with the exact comparator reservePessimistic/reserveOptimistic use, so the lock order is
    // identical to reserve (the SQL sort orders bigint ids numerically, not as this string compare does).
    const movable = rows.filter((r) => r.status === from).sort((a, b) => a.variantId.localeCompare(b.variantId));
    if (movable.length === 0) {
      return { applied: false, alreadyResolved: true, count: 0 };
    }

    let count = 0;
    for (const { variantId, quantity } of movable) {
      const flipped = await tx
        .update(reservations)
        .set({ status: target })
        .where(
          and(eq(reservations.orderId, orderId), eq(reservations.variantId, variantId), eq(reservations.status, from)),
        )
        .returning({ id: reservations.id });
      if (flipped.length === 0) {
        continue;
      }

      await this.bounded.arm(tx);
      await tx
        .update(stockLevels)
        .set({
          quantityOnHand: sql`${stockLevels.quantityOnHand} + ${onHand * quantity}`,
          quantityReserved: sql`${stockLevels.quantityReserved} + ${reserved * quantity}`,
          version: sql`${stockLevels.version} + 1`,
        })
        .where(eq(stockLevels.variantId, variantId));
      count += 1;
    }

    // Every movable row lost the CAS to a concurrent caller → nothing for us to apply.
    if (count === 0) {
      return { applied: false, alreadyResolved: true, count: 0 };
    }
    return { applied: true, alreadyResolved: false, count };
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

  async insertHeader(tx: DrizzleTx, { orderId, status, holdUntil }: ReservationOrderHeader): Promise<boolean> {
    await this.bounded.arm(tx);
    const inserted = await tx
      .insert(reservationOrders)
      .values({ orderId, status, holdUntil })
      .onConflictDoNothing({ target: reservationOrders.orderId })
      .returning({ orderId: reservationOrders.orderId });
    return inserted.length === 1;
  }

  async findHeaderForUpdate(tx: DrizzleTx, orderId: string): Promise<ReservationOrderHeader | null> {
    await this.bounded.arm(tx);
    const [header] = await tx
      .select({
        orderId: reservationOrders.orderId,
        status: reservationOrders.status,
        holdUntil: reservationOrders.holdUntil,
      })
      .from(reservationOrders)
      .where(eq(reservationOrders.orderId, orderId))
      .for('update');
    return header ?? null;
  }

  async updateHeader(tx: DrizzleTx, orderId: string, status: ReservationOrderStatus): Promise<void> {
    await tx.update(reservationOrders).set({ status }).where(eq(reservationOrders.orderId, orderId));
  }

  async findLapsedHeaders({ lapsedBefore, limit }: LapsedHeaderQuery): Promise<LapsedHeader[]> {
    // Skips headers a live participant call holds. The lock ends with the statement, so the caller
    // re-checks each header under its own.
    const rows = await this.db
      .select({ orderId: reservationOrders.orderId, holdUntil: reservationOrders.holdUntil })
      .from(reservationOrders)
      .where(
        and(eq(reservationOrders.status, ReservationOrderStatus.HELD), lt(reservationOrders.holdUntil, lapsedBefore)),
      )
      .orderBy(asc(reservationOrders.holdUntil))
      .limit(limit)
      .for('update', { skipLocked: true });
    // `hold_until < :t` already dropped NULLs.
    return rows.map(({ orderId, holdUntil }) => ({ orderId, holdUntil: holdUntil as Date }));
  }

  private computeExpiry(): Date {
    return new Date(Date.now() + this.reservationTtlMs);
  }
}
