import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { METRICS, type MetricsPort, type TccBranchOutcome } from '@jcool/metrics-port';
import { requireIntConfig } from '@jcool/platform/config';
import { ID_GENERATOR, type IdGeneratorPort } from '@shared/identity/id-generator.port';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { InsufficientStockError } from '../../domain/stock/errors/insufficient-stock.error';
import { ReservationConflictError } from '../../domain/stock/errors/reservation-conflict.error';
import { ReservationTimeoutError } from '../../domain/stock/errors/reservation-timeout.error';
import {
  fenceDecision,
  type FenceDecision,
  type FenceOp,
  type SettledBy,
} from '../../domain/stock/reservation-order-fence';
import { ReservationOrderStatus } from '../../domain/stock/reservation-order-status';
import type {
  CommitOutcome,
  InventoryParticipant,
  ReleaseOutcome,
  RestockOutcome,
  TryReserveInput,
  TryReserveResult,
} from '../public/inventory-participant.port';
import type { ReservationLine } from '../public/product-stock-reservation.port';
import {
  STOCK_REPOSITORY,
  type HoldOptions,
  type LockStrategy,
  type StockRepositoryPort,
} from './ports/stock-repository.port';

const { HELD, FENCED } = ReservationOrderStatus;

// Every path locks the header first, then stock rows by `variantId`, so calls cannot deadlock.
@Injectable()
export class InventoryParticipantService implements InventoryParticipant {
  private readonly strategy: LockStrategy;
  private readonly budgetMs: number;

  constructor(
    @Inject(STOCK_REPOSITORY) private readonly stockRepo: StockRepositoryPort,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGeneratorPort,
    config: ConfigService,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {
    this.strategy = config.get<LockStrategy>('inventory.lockStrategy') ?? 'pessimistic';
    this.budgetMs = requireIntConfig(config, 'inventory.tryLockTimeoutMs', 1);
  }

  async tryReserve({ orderId, lines, holdUntil }: TryReserveInput): Promise<TryReserveResult> {
    const deadline = Date.now() + this.budgetMs;
    let decision: FenceDecision<'try'>;
    let queuedOnHeader = false;
    try {
      // Minted outside the tx so the header lock is never held across a network call.
      const reservationIds = await this.idGenerator.mint(lines.length);
      decision = await this.stockRepo.transaction(
        async (tx) => {
          if (Date.now() >= deadline) {
            throw new ReservationTimeoutError(this.budgetMs);
          }
          // Must be the first statement: a concurrent release then queues behind this key instead of fencing.
          queuedOnHeader = true;
          const inserted = await this.stockRepo.insertHeader(tx, { orderId, status: HELD, holdUntil });
          const current = inserted ? null : await this.lockedStatus(tx, orderId);
          queuedOnHeader = false;
          const decided = fenceDecision('try', current);
          if (decided.kind === 'apply') {
            await this.reserve(tx, orderId, lines, { expiresAt: holdUntil, reservationIds });
          }
          return decided;
        },
        { timeoutMs: Math.max(0, deadline - Date.now()) },
      );
    } catch (error) {
      // Queued on the header means another call for this order may still commit HELD: not a final CONTENDED.
      const rejection = queuedOnHeader ? null : rejectionOf(error);
      this.record('try', rejection ? 'rejected' : 'error');
      if (rejection) {
        return rejection;
      }
      throw error;
    }
    return this.settle('try', decision);
  }

  commit(orderId: string): Promise<{ outcome: CommitOutcome }> {
    return this.resolve('commit', orderId, (tx) => this.stockRepo.commitReservations(tx, orderId));
  }

  release(orderId: string): Promise<{ outcome: ReleaseOutcome }> {
    return this.resolve('release', orderId, (tx) => this.stockRepo.releaseReservations(tx, orderId));
  }

  restock(orderId: string): Promise<{ outcome: RestockOutcome }> {
    return this.resolve('restock', orderId, (tx) => this.stockRepo.restockReservations(tx, orderId));
  }

  private async resolve<Op extends Exclude<FenceOp, 'try'>>(
    op: Op,
    orderId: string,
    moveLines: (tx: DrizzleTx) => Promise<unknown>,
  ): Promise<{ outcome: SettledBy[Op] | 'CONFLICT' }> {
    let decision: FenceDecision<Op>;
    try {
      decision = await this.stockRepo.transaction(
        async (tx) => {
          const header = await this.stockRepo.findHeaderForUpdate(tx, orderId);
          let decided = fenceDecision(op, header?.status ?? null);
          if (decided.kind === 'apply' && decided.to === FENCED) {
            if (await this.stockRepo.insertHeader(tx, { orderId, status: FENCED, holdUntil: null })) {
              return decided;
            }
            // A Try inserted its header after the read above, and the insert waited for it to commit.
            decided = fenceDecision(op, await this.lockedStatus(tx, orderId));
          }
          if (decided.kind === 'apply') {
            await moveLines(tx);
            await this.stockRepo.updateHeader(tx, orderId, decided.to);
          }
          return decided;
        },
        { timeoutMs: this.budgetMs },
      );
    } catch (error) {
      this.record(op, 'error');
      throw error;
    }
    return this.settle(op, decision);
  }

  private settle<Op extends FenceOp>(op: Op, decision: FenceDecision<Op>): { outcome: SettledBy[Op] | 'CONFLICT' } {
    switch (decision.kind) {
      case 'apply':
        this.record(op, decision.to === FENCED ? 'fenced' : 'ok');
        return { outcome: decision.to };
      case 'idempotent':
        this.record(op, 'idempotent');
        return { outcome: decision.status };
      case 'conflict':
        this.record(op, 'conflict');
        return { outcome: 'CONFLICT' };
    }
  }

  private async lockedStatus(tx: DrizzleTx, orderId: string): Promise<ReservationOrderStatus> {
    const header = await this.stockRepo.findHeaderForUpdate(tx, orderId);
    if (!header) {
      throw new Error(`Reservation header for order ${orderId} lost an insert race yet cannot be read`);
    }
    return header.status;
  }

  private reserve(tx: DrizzleTx, orderId: string, lines: ReservationLine[], options: HoldOptions): Promise<void> {
    return this.strategy === 'optimistic'
      ? this.stockRepo.reserveOptimistic(tx, orderId, lines, options)
      : this.stockRepo.reservePessimistic(tx, orderId, lines, options);
  }

  private record(op: FenceOp, outcome: TccBranchOutcome): void {
    this.metrics.recordTccBranch('inventory', op, outcome);
  }
}

function rejectionOf(error: unknown): TryReserveResult | null {
  if (error instanceof InsufficientStockError) {
    return { outcome: 'OUT_OF_STOCK', detail: error.message };
  }
  if (error instanceof ReservationConflictError || error instanceof ReservationTimeoutError) {
    return { outcome: 'CONTENDED', detail: error.message };
  }
  return null;
}
