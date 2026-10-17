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
  type FenceOutcome,
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
import {
  STOCK_REPOSITORY,
  type HoldOptions,
  type ReservationLine,
  type StockRepositoryPort,
  type StockResolveResult,
} from './ports/stock-repository.port';
import type { LockStrategy } from './reserve-stock.use-case';

const { HELD, FENCED } = ReservationOrderStatus;

type ResolveOp = Exclude<FenceOp, 'try'>;

// Every call locks the order's header before any stock row, in the same variantId order as the
// legacy path, so participant calls cannot deadlock with each other or with checkout.
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
    const startedAt = Date.now();
    const remainingMs = () => this.budgetMs - (Date.now() - startedAt);
    let queuedOnHeader = false;
    try {
      // Before BEGIN, so the header lock is never held across a call to the id service.
      const reservationIds = await this.idGenerator.mint(lines.length);
      const decision = await this.stockRepo.transaction(
        async (tx) => {
          if (remainingMs() <= 0) {
            throw new ReservationTimeoutError(this.budgetMs);
          }
          // Must be the first write: a release racing this Try then queues on the key instead of fencing.
          queuedOnHeader = true;
          const inserted = await this.stockRepo.insertHeader(tx, { orderId, status: HELD, holdUntil });
          const decided = fenceDecision('try', inserted ? null : await this.lockedStatus(tx, orderId));
          queuedOnHeader = false;
          if (decided.kind === 'apply') {
            await this.reserve(tx, orderId, lines, { expiresAt: holdUntil, reservationIds });
          }
          return decided;
        },
        { timeoutMs: Math.max(0, remainingMs()) },
      );
      return { outcome: this.settle('try', decision) };
    } catch (error) {
      // Queued behind another call for this order, which may still commit HELD: no final answer yet.
      const rejection = queuedOnHeader ? undefined : rejectionOf(error);
      this.record('try', rejection ? 'rejected' : 'error');
      if (rejection) {
        return rejection;
      }
      throw error;
    }
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

  private async resolve<Op extends ResolveOp>(
    op: Op,
    orderId: string,
    moveLines: (tx: DrizzleTx) => Promise<StockResolveResult>,
  ): Promise<{ outcome: FenceOutcome[Op] | 'CONFLICT' }> {
    try {
      const decision = await this.stockRepo.transaction(
        async (tx) => {
          const header = await this.stockRepo.findHeaderForUpdate(tx, orderId);
          let decided = fenceDecision(op, header?.status ?? null);
          if (decided.kind === 'apply' && decided.status === FENCED) {
            if (await this.stockRepo.insertHeader(tx, { orderId, status: FENCED, holdUntil: null })) {
              return decided;
            }
            // A Try inserted its header after our read, and the insert above waited for it to commit.
            decided = fenceDecision(op, await this.lockedStatus(tx, orderId));
          }
          if (decided.kind === 'apply') {
            if ((await moveLines(tx)).alreadyResolved) {
              throw new Error(`Lines of order ${orderId} were moved behind its header's back; refusing to ${op}`);
            }
            await this.stockRepo.updateHeader(tx, orderId, decided.status);
          }
          return decided;
        },
        { timeoutMs: this.budgetMs },
      );
      return { outcome: this.settle(op, decision) };
    } catch (error) {
      this.record(op, 'error');
      throw error;
    }
  }

  private settle<Op extends FenceOp>(op: Op, decision: FenceDecision<Op>): FenceOutcome[Op] | 'CONFLICT' {
    if (decision.kind === 'conflict') {
      this.record(op, 'conflict');
      return 'CONFLICT';
    }
    if (decision.kind === 'idempotent') {
      this.record(op, 'idempotent');
    } else {
      this.record(op, decision.status === FENCED ? 'fenced' : 'ok');
    }
    return decision.status;
  }

  private async lockedStatus(tx: DrizzleTx, orderId: string): Promise<ReservationOrderStatus> {
    const header = await this.stockRepo.findHeaderForUpdate(tx, orderId);
    if (!header) {
      throw new Error(`Reservation header of order ${orderId} conflicted on insert but cannot be read`);
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

function rejectionOf(error: unknown): TryReserveResult | undefined {
  if (error instanceof InsufficientStockError) {
    return { outcome: 'OUT_OF_STOCK', detail: error.message };
  }
  if (error instanceof ReservationConflictError || error instanceof ReservationTimeoutError) {
    return { outcome: 'CONTENDED', detail: error.message };
  }
  return undefined;
}
