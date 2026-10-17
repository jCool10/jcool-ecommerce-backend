import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { requireIntConfig } from '@jcool/platform/config';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { ReservationOrderStatus } from '../../domain/stock/reservation-order-status';
import { STOCK_REPOSITORY, type StockRepositoryPort } from './ports/stock-repository.port';

const LOG_CONTEXT = 'ReleaseLapsedHolds';

export interface LapsedHoldSweepInput {
  batchSize: number;
}

export interface LapsedHoldSweepSummary {
  scanned: number;
  released: number;
  /** Already committed or released by the time the sweep locked the header. */
  raced: number;
  /** Threw; the header stays HELD and the next tick tries again. */
  errors: number;
}

// The participant's own safety net: it frees stock and nothing else. Whether the order failed is the
// orchestrator's call, so the sweep never touches orders.
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
    const lapsed = await this.stockRepo.findLapsedHeaders({ lapsedBefore: new Date(), limit: batchSize });
    const summary: LapsedHoldSweepSummary = { scanned: lapsed.length, released: 0, raced: 0, errors: 0 };

    for (const { orderId, holdUntil } of lapsed) {
      try {
        const released = await this.stockRepo.transaction((tx) => this.releaseIfHeld(tx, orderId), {
          timeoutMs: this.txTimeoutMs,
        });
        summary[released ? 'released' : 'raced'] += 1;
        this.metrics.recordTccBranch('inventory', 'sweep', released ? 'ok' : 'conflict');
      } catch (error) {
        summary.errors += 1;
        this.metrics.recordTccBranch('inventory', 'sweep', 'error');
        this.logger.warn({ orderId, holdUntil, err: toError(error) }, 'lapsed hold release failed');
      }
    }
    return summary;
  }

  private async releaseIfHeld(tx: DrizzleTx, orderId: string): Promise<boolean> {
    const header = await this.stockRepo.findHeaderForUpdate(tx, orderId);
    if (header?.status !== ReservationOrderStatus.HELD) {
      return false;
    }
    await this.stockRepo.releaseReservations(tx, orderId);
    await this.stockRepo.updateHeader(tx, orderId, ReservationOrderStatus.RELEASED);
    return true;
  }
}
