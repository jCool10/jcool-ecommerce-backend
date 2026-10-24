import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { METRICS, type MetricsPort, type TccBranchOutcome, type TccOp } from '@jcool/metrics-port';
import { requireIntConfig } from '@jcool/platform/config';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { ID_GENERATOR, type IdGeneratorPort } from '@shared/identity/id-generator.port';
import { InsufficientStockError } from '../../domain/stock/errors/insufficient-stock.error';
import { ReservationConflictError } from '../../domain/stock/errors/reservation-conflict.error';
import { ReservationTimeoutError } from '../../domain/stock/errors/reservation-timeout.error';
import { decideReservationFence } from '../../domain/stock/reservation-order-fence';
import type { ReservationOrderStatus } from '../../domain/stock/reservation-order-status';
import type {
  InventoryParticipant,
  ParticipantCommandOutcome,
  TryReserveInput,
  TryReserveOutcome,
} from '../public/inventory-participant.port';
import { STOCK_REPOSITORY, type StockRepositoryPort } from './ports/stock-repository.port';

const LOG_CONTEXT = 'InventoryParticipant';

type LockStrategy = 'pessimistic' | 'optimistic';

type CommandOp = 'commit' | 'release' | 'restock';

const OUTCOME_LABEL: Record<TryReserveOutcome | ParticipantCommandOutcome, TccBranchOutcome> = {
  RESERVED: 'reserved',
  OUT_OF_STOCK: 'out_of_stock',
  CONTENDED: 'contended',
  CONFLICT: 'conflict',
  APPLIED: 'applied',
  IDEMPOTENT: 'idempotent',
};

@Injectable()
export class InventoryParticipantService implements InventoryParticipant {
  private readonly budgetMs: number;
  private readonly strategy: LockStrategy;

  constructor(
    @Inject(STOCK_REPOSITORY) private readonly stockRepo: StockRepositoryPort,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGeneratorPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.budgetMs = requireIntConfig(config, 'inventory.tryLockTimeoutMs', 1);
    this.strategy = config.get<LockStrategy>('inventory.lockStrategy') ?? 'pessimistic';
    logger.setContext(LOG_CONTEXT);
  }

  tryReserve({ orderId, lines, holdUntil }: TryReserveInput): Promise<TryReserveOutcome> {
    const deadline = Date.now() + this.budgetMs;
    return this.observe('try', async () => {
      // Outside the tx: no lock may be held across a network call.
      const reservationIds = await this.idGenerator.mint(lines.length);
      try {
        return await this.inTransaction(deadline, async (tx): Promise<TryReserveOutcome> => {
          if (await this.stockRepo.insertHeader(tx, { orderId, holdUntil })) {
            const options = { expiresAt: holdUntil, reservationIds };
            if (this.strategy === 'optimistic') {
              await this.stockRepo.reserveOptimistic(tx, orderId, lines, options);
            } else {
              await this.stockRepo.reservePessimistic(tx, orderId, lines, options);
            }
            return 'RESERVED';
          }

          const header = await this.stockRepo.findHeaderForUpdate(tx, orderId);
          if (!header) {
            throw new Error(`Reservation header of order ${orderId} lost an insert race yet cannot be read`);
          }
          return decideReservationFence('try', header.status).kind === 'conflict' ? 'CONFLICT' : 'RESERVED';
        });
      } catch (error) {
        if (error instanceof InsufficientStockError) {
          const { variantId, requested, available } = error;
          this.logger.warn({ orderId, variantId, requested, available }, 'try refused: insufficient stock');
          return 'OUT_OF_STOCK';
        }
        if (error instanceof ReservationConflictError) {
          return 'CONTENDED';
        }
        throw error;
      }
    });
  }

  commit(orderId: string): Promise<ParticipantCommandOutcome> {
    return this.runCommand('commit', orderId);
  }

  release(orderId: string): Promise<ParticipantCommandOutcome> {
    return this.runCommand('release', orderId);
  }

  restock(orderId: string): Promise<ParticipantCommandOutcome> {
    return this.runCommand('restock', orderId);
  }

  async statusOf(orderIds: string[]): Promise<Map<string, ReservationOrderStatus | null>> {
    if (orderIds.length === 0) {
      return new Map();
    }
    const found = await this.stockRepo.findHeaderStatuses(orderIds);
    return new Map(orderIds.map((orderId) => [orderId, found.get(orderId) ?? null]));
  }

  private runCommand(op: CommandOp, orderId: string): Promise<ParticipantCommandOutcome> {
    return this.observe(op, () =>
      this.inTransaction(Date.now() + this.budgetMs, async (tx): Promise<ParticipantCommandOutcome> => {
        let header = await this.stockRepo.findHeaderForUpdate(tx, orderId);
        if (!header && op === 'release') {
          if (await this.stockRepo.insertFencedHeader(tx, orderId)) {
            return 'APPLIED';
          }
          // Our insert waited on a Try's uncommitted header, and that Try committed.
          header = await this.stockRepo.findHeaderForUpdate(tx, orderId);
        }

        const decision = decideReservationFence(op, header?.status ?? null);
        if (decision.kind !== 'apply') {
          return decision.kind === 'idempotent' ? 'IDEMPOTENT' : 'CONFLICT';
        }
        await this.moveLines(op, tx, orderId);
        await this.stockRepo.setHeaderStatus(tx, orderId, decision.next);
        return 'APPLIED';
      }),
    );
  }

  private moveLines(op: CommandOp, tx: DrizzleTx, orderId: string) {
    switch (op) {
      case 'commit':
        return this.stockRepo.commitReservations(tx, orderId);
      case 'release':
        return this.stockRepo.releaseReservations(tx, orderId);
      case 'restock':
        return this.stockRepo.restockReservations(tx, orderId);
    }
  }

  private inTransaction<T>(deadline: number, work: (tx: DrizzleTx) => Promise<T>): Promise<T> {
    return this.stockRepo.transaction(
      (tx) => {
        // Nothing cuts the wait for a pooled connection short, so check what it left before writing anything.
        if (Date.now() >= deadline) {
          throw new ReservationTimeoutError();
        }
        return work(tx);
      },
      { deadline },
    );
  }

  private async observe<T extends TryReserveOutcome | ParticipantCommandOutcome>(
    op: TccOp,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      const outcome = await run();
      this.metrics.recordTccBranch('inventory', op, OUTCOME_LABEL[outcome]);
      return outcome;
    } catch (error) {
      this.metrics.recordTccBranch('inventory', op, 'error');
      throw error;
    }
  }
}
