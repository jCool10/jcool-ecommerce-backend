import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, lt, notExists, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import { InsufficientStockError } from '../../domain/stock/errors/insufficient-stock.error';
import { ReservationConflictError } from '../../domain/stock/errors/reservation-conflict.error';
import { ReservationOrderStatus } from '../../domain/stock/reservation-order-status';
import { ReservationStatus } from '../../domain/stock/reservation-status';
import type {
  HoldOptions,
  ReservationLine,
  ReservationOrderHeader,
  StockRepositoryPort,
  StockResolveResult,
  StockTransactionOptions,
} from '../../application/stock/ports/stock-repository.port';
import { reservationOrders, reservations, stockLevels } from './schema/stock.schema';
import { TransactionDeadlines } from './transaction-deadlines';

type LineTransition =
  | { from: typeof ReservationStatus.HELD; to: typeof ReservationStatus.COMMITTED }
  | { from: typeof ReservationStatus.HELD; to: typeof ReservationStatus.RELEASED }
  | { from: typeof ReservationStatus.COMMITTED; to: typeof ReservationStatus.RESTOCKED };

const STOCK_DELTA: Record<LineTransition['to'], (quantity: number) => Record<string, SQL>> = {
  COMMITTED: (quantity) => ({
    quantityOnHand: sql`${stockLevels.quantityOnHand} - ${quantity}`,
    quantityReserved: sql`${stockLevels.quantityReserved} - ${quantity}`,
  }),
  RELEASED: (quantity) => ({ quantityReserved: sql`${stockLevels.quantityReserved} - ${quantity}` }),
  RESTOCKED: (quantity) => ({ quantityOnHand: sql`${stockLevels.quantityOnHand} + ${quantity}` }),
};

@Injectable()
export class StockRepository implements StockRepositoryPort {
  private readonly maxRetries: number;
  private readonly deadlines = new TransactionDeadlines();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    config: ConfigService,
  ) {
    this.maxRetries = config.getOrThrow<number>('inventory.optimisticMaxRetries');
  }

  transaction<T>(work: (tx: DrizzleTx) => Promise<T>, { deadline }: StockTransactionOptions = {}): Promise<T> {
    return deadline === undefined ? this.db.transaction(work) : this.deadlines.run(this.db, deadline, work);
  }

  async reservePessimistic(
    tx: DrizzleTx,
    orderId: string,
    lines: ReservationLine[],
    { expiresAt, reservationIds: ids }: HoldOptions,
  ): Promise<void> {
    // Lock rows in a deterministic order so two orders holding the same SKUs can't deadlock.
    const ordered = [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId));
    for (const [index, { variantId, quantity }] of ordered.entries()) {
      await this.deadlines.limit(tx);
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

      await this.insertHold(tx, { id: ids[index], orderId, variantId, quantity, expiresAt });
    }
  }

  async reserveOptimistic(
    tx: DrizzleTx,
    orderId: string,
    lines: ReservationLine[],
    { expiresAt, reservationIds: ids }: HoldOptions,
  ): Promise<void> {
    // A successful UPDATE still holds a row write-lock until the tx ends, so keep the same
    // deterministic order as the pessimistic path to rule out a cross-order deadlock.
    const ordered = [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId));
    for (const [index, { variantId, quantity }] of ordered.entries()) {
      if (await this.casReserve(tx, orderId, variantId, quantity)) {
        await this.insertHold(tx, { id: ids[index], orderId, variantId, quantity, expiresAt });
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
    hold: { id: string; orderId: string; variantId: string; quantity: number; expiresAt: Date },
  ): Promise<void> {
    await tx
      .insert(reservations)
      .values({ ...hold, status: ReservationStatus.HELD })
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

      await this.deadlines.limit(tx);
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
    return this.moveLines(tx, orderId, { from: ReservationStatus.HELD, to: ReservationStatus.COMMITTED });
  }

  releaseReservations(tx: DrizzleTx, orderId: string): Promise<StockResolveResult> {
    return this.moveLines(tx, orderId, { from: ReservationStatus.HELD, to: ReservationStatus.RELEASED });
  }

  restockReservations(tx: DrizzleTx, orderId: string): Promise<StockResolveResult> {
    return this.moveLines(tx, orderId, { from: ReservationStatus.COMMITTED, to: ReservationStatus.RESTOCKED });
  }

  // The per-line UPDATE locks the shared stock rows in the SAME order the reserve path uses —
  // `variantId` ascending — so two orders touching overlapping SKUs cannot deadlock. Each flip is a
  // CAS on the `from` status, so a duplicate resolve moves the stock delta exactly once.
  private async moveLines(tx: DrizzleTx, orderId: string, { from, to }: LineTransition): Promise<StockResolveResult> {
    const rows = await tx
      .select({ variantId: reservations.variantId, quantity: reservations.quantity, status: reservations.status })
      .from(reservations)
      .where(eq(reservations.orderId, orderId));

    if (rows.length === 0) {
      return { applied: false, alreadyResolved: false, count: 0 };
    }
    // Sort in JS with the exact comparator reservePessimistic/reserveOptimistic use, so the lock order is
    // identical to reserve (the SQL sort orders bigint ids numerically, not as this string compare does).
    const pending = rows.filter((r) => r.status === from).sort((a, b) => a.variantId.localeCompare(b.variantId));
    if (pending.length === 0) {
      return { applied: false, alreadyResolved: true, count: 0 };
    }

    let count = 0;
    for (const { variantId, quantity } of pending) {
      const flipped = await tx
        .update(reservations)
        .set({ status: to })
        .where(
          and(eq(reservations.orderId, orderId), eq(reservations.variantId, variantId), eq(reservations.status, from)),
        )
        .returning({ id: reservations.id });
      if (flipped.length === 0) {
        continue;
      }

      await this.deadlines.limit(tx);
      await tx
        .update(stockLevels)
        .set({ ...STOCK_DELTA[to](quantity), version: sql`${stockLevels.version} + 1` })
        .where(eq(stockLevels.variantId, variantId));
      count += 1;
    }

    // Every pending row lost the CAS to a concurrent resolver → nothing for us to apply.
    if (count === 0) {
      return { applied: false, alreadyResolved: true, count: 0 };
    }
    return { applied: true, alreadyResolved: false, count };
  }

  // First statement of a Try: a concurrent Release of the same order blocks on this uncommitted row
  // instead of racing past it.
  async insertHeader(tx: DrizzleTx, { orderId, holdUntil }: { orderId: string; holdUntil: Date }): Promise<boolean> {
    return this.insertHeaderRow(tx, { orderId, status: ReservationOrderStatus.HELD, holdUntil });
  }

  async insertFencedHeader(tx: DrizzleTx, orderId: string): Promise<boolean> {
    return this.insertHeaderRow(tx, { orderId, status: ReservationOrderStatus.FENCED, holdUntil: null });
  }

  private async insertHeaderRow(
    tx: DrizzleTx,
    row: { orderId: string; status: ReservationOrderStatus; holdUntil: Date | null },
  ): Promise<boolean> {
    await this.deadlines.limit(tx);
    const inserted = await tx
      .insert(reservationOrders)
      .values(row)
      .onConflictDoNothing()
      .returning({ orderId: reservationOrders.orderId });
    return inserted.length === 1;
  }

  async findHeaderForUpdate(tx: DrizzleTx, orderId: string): Promise<ReservationOrderHeader | null> {
    await this.deadlines.limit(tx);
    const [header] = await tx
      .select({ status: reservationOrders.status, holdUntil: reservationOrders.holdUntil })
      .from(reservationOrders)
      .where(eq(reservationOrders.orderId, orderId))
      .for('update');
    return header ?? null;
  }

  async lockLapsedHeader(tx: DrizzleTx, orderId: string): Promise<boolean> {
    const locked = await tx
      .select({ orderId: reservationOrders.orderId })
      .from(reservationOrders)
      .where(
        and(
          eq(reservationOrders.orderId, orderId),
          eq(reservationOrders.status, ReservationOrderStatus.HELD),
          lt(reservationOrders.holdUntil, sql`now()`),
        ),
      )
      .for('update', { skipLocked: true });
    return locked.length === 1;
  }

  async setHeaderStatus(tx: DrizzleTx, orderId: string, status: ReservationOrderStatus): Promise<void> {
    await tx.update(reservationOrders).set({ status }).where(eq(reservationOrders.orderId, orderId));
  }

  async findLapsedHeaderIds({ limit }: { limit: number }): Promise<string[]> {
    const rows = await this.db
      .select({ orderId: reservationOrders.orderId })
      .from(reservationOrders)
      .where(
        and(eq(reservationOrders.status, ReservationOrderStatus.HELD), lt(reservationOrders.holdUntil, sql`now()`)),
      )
      .orderBy(asc(reservationOrders.holdUntil))
      .limit(limit);
    return rows.map((row) => row.orderId);
  }

  async findHeaderStatuses(orderIds: string[]): Promise<Map<string, ReservationOrderStatus>> {
    const rows = await this.db
      .select({ orderId: reservationOrders.orderId, status: reservationOrders.status })
      .from(reservationOrders)
      .where(sql`${reservationOrders.orderId} = ANY(${sql.param(orderIds)}::bigint[])`);
    return new Map(rows.map((row) => [row.orderId, row.status]));
  }
}
