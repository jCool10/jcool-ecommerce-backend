import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { durationToMs } from '@jcool/kernel';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import { ID_GENERATOR, type IdGeneratorPort } from '@shared/identity/id-generator.port';
import { InsufficientStockError } from '../../domain/stock/errors/insufficient-stock.error';
import { ReservationConflictError } from '../../domain/stock/errors/reservation-conflict.error';
import { ReservationTimeoutError } from '../../domain/stock/errors/reservation-timeout.error';
import { ReservationOrderStatus } from '../../domain/stock/reservation-order-status';
import { ReservationStatus } from '../../domain/stock/reservation-status';
import type {
  ExpiredHold,
  ExpiredHoldQuery,
  HoldOptions,
  LapsedHeaderQuery,
  LapsedHold,
  ReservationLine,
  ReservationOrderHeader,
  StockRepositoryPort,
  StockResolveResult,
  StockTransactionOptions,
} from '../../application/stock/ports/stock-repository.port';
import { reservationOrders, reservations, stockLevels } from './schema/stock.schema';

// What `lock_timeout` and `statement_timeout` raise: lock_not_available and query_canceled.
const TIMEOUT_SQLSTATES: ReadonlySet<string> = new Set(['55P03', '57014']);

interface TransactionBound {
  deadline: number;
  timeoutMs: number;
}

type LineTarget =
  typeof ReservationStatus.COMMITTED | typeof ReservationStatus.RELEASED | typeof ReservationStatus.RESTOCKED;

// No move raises `reserved` or drops on-hand alone, so none can break `ck_stock_no_oversell`.
const LINE_MOVES: Record<LineTarget, { from: ReservationStatus; onHand: -1 | 0 | 1; reserved: -1 | 0 }> = {
  COMMITTED: { from: ReservationStatus.HELD, onHand: -1, reserved: -1 },
  RELEASED: { from: ReservationStatus.HELD, onHand: 0, reserved: -1 },
  RESTOCKED: { from: ReservationStatus.COMMITTED, onHand: 1, reserved: 0 },
};

@Injectable()
export class StockRepository implements StockRepositoryPort {
  private readonly reservationTtlMs: number;
  private readonly maxRetries: number;
  private readonly bounds = new WeakMap<DrizzleTx, TransactionBound>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGeneratorPort,
    config: ConfigService,
  ) {
    this.reservationTtlMs = durationToMs(config.getOrThrow<string>('inventory.reservationTtl'));
    this.maxRetries = config.getOrThrow<number>('inventory.optimisticMaxRetries');
  }

  async transaction<T>(work: (tx: DrizzleTx) => Promise<T>, { timeoutMs }: StockTransactionOptions = {}): Promise<T> {
    // Stamped before acquiring a connection, so the pool wait spends the bound too.
    const bound = timeoutMs === undefined ? undefined : { deadline: Date.now() + timeoutMs, timeoutMs };
    try {
      return await this.db.transaction(async (tx) => {
        if (!bound) {
          return work(tx);
        }
        this.bounds.set(tx, bound);
        try {
          return await work(tx);
        } catch (error) {
          await this.liftStatementTimeout(tx);
          throw error;
        }
      });
    } catch (error) {
      if (bound && hasSqlState(error, TIMEOUT_SQLSTATES)) {
        throw new ReservationTimeoutError(bound.timeoutMs);
      }
      throw error;
    }
  }

  // Postgres restarts both timeouts per statement, so a fixed SET LOCAL would overrun once per row.
  private async spendBound(tx: DrizzleTx): Promise<void> {
    const bound = this.bounds.get(tx);
    if (!bound) {
      return;
    }
    const remainingMs = bound.deadline - Date.now();
    if (remainingMs <= 0) {
      throw new ReservationTimeoutError(bound.timeoutMs);
    }
    const limit = `${remainingMs}ms`;
    // `set_config(..., true)` is a SET LOCAL that accepts bind parameters.
    await tx.execute(
      sql`SELECT set_config('lock_timeout', ${limit}, true), set_config('statement_timeout', ${limit}, true)`,
    );
  }

  // Otherwise ROLLBACK runs under a possibly 1ms statement_timeout, and a cancelled one leaks an aborted tx to the pool.
  private async liftStatementTimeout(tx: DrizzleTx): Promise<void> {
    try {
      await tx.execute(sql`SET LOCAL statement_timeout TO DEFAULT`);
    } catch {
      // Already aborted.
    }
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
      await this.spendBound(tx);
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

      await this.insertHold(tx, ids[index], orderId, variantId, quantity, expiresAt);
    }
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
  // if that version and the available quantity still hold. Zero rows means either a real
  // shortfall (throw, no retry) or a concurrent version bump (retry at once).
  // The retry never backs off: under READ COMMITTED a lost CAS is only visible once the
  // conflicting writer has committed and dropped its row lock, so sleeping relieves no
  // contention while extending the write locks this transaction already holds on earlier lines.
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

      await this.spendBound(tx);
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

      await this.spendBound(tx);
      await tx
        .update(stockLevels)
        .set({
          ...(onHand !== 0 && { quantityOnHand: sql`${stockLevels.quantityOnHand} + ${onHand * quantity}` }),
          ...(reserved !== 0 && { quantityReserved: sql`${stockLevels.quantityReserved} + ${reserved * quantity}` }),
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
    await this.spendBound(tx);
    const inserted = await tx
      .insert(reservationOrders)
      .values({ orderId, status, holdUntil })
      .onConflictDoNothing({ target: reservationOrders.orderId })
      .returning({ orderId: reservationOrders.orderId });
    return inserted.length === 1;
  }

  async findHeaderForUpdate(tx: DrizzleTx, orderId: string): Promise<ReservationOrderHeader | null> {
    await this.spendBound(tx);
    const [row] = await tx
      .select({
        orderId: reservationOrders.orderId,
        status: reservationOrders.status,
        holdUntil: reservationOrders.holdUntil,
      })
      .from(reservationOrders)
      .where(eq(reservationOrders.orderId, orderId))
      .for('update');
    return row ?? null;
  }

  async updateHeader(tx: DrizzleTx, orderId: string, status: ReservationOrderStatus): Promise<void> {
    await tx.update(reservationOrders).set({ status }).where(eq(reservationOrders.orderId, orderId));
  }

  async findLapsedHeaders({ lapsedBefore, limit }: LapsedHeaderQuery): Promise<LapsedHold[]> {
    // SKIP LOCKED only avoids queueing behind a live call; it dedupes nothing across sweeps.
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

// Walks the `cause` chain, because Drizzle wraps the driver error that carries the SQLSTATE.
function hasSqlState(error: unknown, codes: ReadonlySet<string>): boolean {
  for (let current: unknown = error, depth = 0; current != null && depth < 5; depth++) {
    if (typeof current !== 'object') {
      return false;
    }
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && codes.has(code)) {
      return true;
    }
    current = cause;
  }
  return false;
}
