import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { requireIntConfig } from '@jcool/platform/config';
import { ReservationOrderStatus } from '../../domain/stock/reservation-order-status';
import { STOCK_REPOSITORY, type StockRepositoryPort } from './ports/stock-repository.port';

const LOG_CONTEXT = 'ReleaseLapsedHolds';

export interface LapsedHoldSweepInput {
  batchSize: number;
}

export interface LapsedHoldSweepSummary {
  scanned: number;
  released: number;
  /** Resolved by someone else between claim and lock. */
  raced: number;
  errors: number;
}

// Releases stock only; the order's outcome stays the orchestrator's to decide.
@Injectable()
export class ReleaseLapsedHoldsUseCase {
  private readonly txTimeoutMs: number;

  constructor(
    @Inject(STOCK_REPOSITORY) private readonly stockRepo: StockRepositoryPort,
    config: ConfigService,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    this.txTimeoutMs = requireIntConfig(config, 'inventory.tryLockTimeoutMs', 1);
    logger.setContext(LOG_CONTEXT);
  }

  async execute({ batchSize }: LapsedHoldSweepInput): Promise<LapsedHoldSweepSummary> {
    const now = new Date();
    const lapsed = await this.stockRepo.findLapsedHeaders({ lapsedBefore: now, limit: batchSize });
    const summary: LapsedHoldSweepSummary = { scanned: lapsed.length, released: 0, raced: 0, errors: 0 };

    for (const { orderId, holdUntil } of lapsed) {
      try {
        const released = await this.stockRepo.transaction(
          async (tx) => {
            const header = await this.stockRepo.findHeaderForUpdate(tx, orderId);
            if (header?.status !== ReservationOrderStatus.HELD || !header.holdUntil || header.holdUntil >= now) {
              return false;
            }
            await this.stockRepo.releaseReservations(tx, orderId);
            await this.stockRepo.updateHeader(tx, orderId, ReservationOrderStatus.RELEASED);
            return true;
          },
          { timeoutMs: this.txTimeoutMs },
        );
        if (released) {
          summary.released += 1;
          this.metrics.recordTccBranch('inventory', 'sweep', 'ok');
        } else {
          summary.raced += 1;
          this.metrics.recordTccBranch('inventory', 'sweep', 'conflict');
        }
      } catch (error) {
        summary.errors += 1;
        this.metrics.recordTccBranch('inventory', 'sweep', 'error');
        this.logger.warn({ orderId, holdUntil, err: toError(error) }, 'lapsed hold release failed for order');
      }
    }

    return summary;
  }
}
