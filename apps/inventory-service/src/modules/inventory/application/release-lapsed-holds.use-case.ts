import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { requireIntConfig } from '@jcool/platform/config';
import { ReservationOrderStatus } from '../domain/reservation-order-status';
import { STOCK_REPOSITORY, type StockRepositoryPort } from './ports/stock-repository.port';

const LOG_CONTEXT = 'ReleaseLapsedHolds';

export interface LapsedHoldSweepSummary {
  scanned: number;
  released: number;
  /** No longer a lapsed HELD header by the time it was locked, or locked by a command right now. */
  raced: number;
  /** Threw; the next tick retries them. */
  errors: number;
}

/**
 * Safety net for participant holds the orchestrator never resolved. It only releases stock: whether
 * the order is over is the order's call, never this sweep's. Legacy reservations have no header and
 * are never looked at here.
 */
@Injectable()
export class ReleaseLapsedHoldsUseCase {
  private readonly budgetMs: number;

  constructor(
    @Inject(STOCK_REPOSITORY) private readonly stockRepo: StockRepositoryPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.budgetMs = requireIntConfig(config, 'inventory.tryLockTimeoutMs', 1);
    logger.setContext(LOG_CONTEXT);
  }

  async execute({ batchSize }: { batchSize: number }): Promise<LapsedHoldSweepSummary> {
    const orderIds = await this.stockRepo.findLapsedHeaderIds({ limit: batchSize });
    const summary: LapsedHoldSweepSummary = { scanned: orderIds.length, released: 0, raced: 0, errors: 0 };

    for (const orderId of orderIds) {
      try {
        const released = await this.stockRepo.transaction(
          async (tx) => {
            if (!(await this.stockRepo.lockLapsedHeader(tx, orderId))) {
              return false;
            }
            await this.stockRepo.releaseReservations(tx, orderId);
            await this.stockRepo.setHeaderStatus(tx, orderId, ReservationOrderStatus.RELEASED);
            return true;
          },
          { deadline: Date.now() + this.budgetMs },
        );
        if (released) {
          summary.released += 1;
          this.metrics.recordTccBranch('inventory', 'lapse_release', 'applied');
        } else {
          summary.raced += 1;
        }
      } catch (error) {
        summary.errors += 1;
        this.metrics.recordTccBranch('inventory', 'lapse_release', 'error');
        this.logger.warn({ orderId, err: toError(error) }, 'lapsed hold release failed for order');
      }
    }

    return summary;
  }
}
