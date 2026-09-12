import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@shared/kernel/to-error';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { OrderStatus } from '../../domain/order-status';
import { INVENTORY_RESERVATION, type InventoryReservationPort } from '../ports/inventory-reservation.port';
import { FinalizeOrderUseCase } from './finalize-order.use-case';

const LOG_CONTEXT = 'SweepExpiredReservations';

export interface SweepInput {
  /** Extra age past a hold's expiry before this sweep claims it. */
  graceSec: number;
  /** Cap on reservation rows read per tick; the rest wait for the next one. */
  batchSize: number;
}

export interface SweepSummary {
  scanned: number;
  expired: number;
  /** No longer PENDING by the time the sweep reached them — something else settled the order. */
  raced: number;
  /** Threw (DB fault); the next tick retries them. */
  errors: number;
}

/**
 * The liveness backstop: an order whose stock hold has lapsed and which nothing ever settled is
 * expired here. It asks the gateway nothing — which is what lets it converge during an outage, and
 * also why the session it leaves open has to be closed by Payment reacting to `order.expired`.
 */
@Injectable()
export class SweepExpiredReservationsUseCase {
  constructor(
    @Inject(INVENTORY_RESERVATION) private readonly inventory: InventoryReservationPort,
    private readonly finalizeOrder: FinalizeOrderUseCase,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async execute({ graceSec, batchSize }: SweepInput): Promise<SweepSummary> {
    const holds = await this.inventory.findExpiredHolds({
      expiredBefore: new Date(Date.now() - graceSec * 1000),
      limit: batchSize,
    });

    const summary: SweepSummary = { scanned: holds.length, expired: 0, raced: 0, errors: 0 };

    for (const { orderId, expiresAt } of holds) {
      try {
        const result = await this.finalizeOrder.execute({
          orderId,
          outcome: OrderStatus.EXPIRED,
          reason: 'ttl:expired',
        });
        if (result.status === 'finalized') {
          summary.expired += 1;
          // Only this branch: the races below were expired by someone else, and counting them here
          // would erase the difference between this sweep and reconcile that the counter exists for.
          this.metrics.recordReservationExpiry();
          continue;
        }

        summary.raced += 1;
        // Usually benign — a settlement committed between the read and the lock, releasing the hold
        // with it. A hold that genuinely outlives its settled order returns every tick, so it is the
        // same orderId at an `expiresAt` that keeps receding into the past that signals divergence.
        this.logger.warn(
          { orderId, expiresAt, status: result.order?.status, finalize: result.status },
          'expired hold belongs to an order that is no longer pending',
        );
      } catch (error) {
        summary.errors += 1;
        // One unhappy order must not cost the rest of the batch its tick.
        this.logger.warn({ orderId, err: toError(error) }, 'expiry sweep failed for order');
      }
    }

    return summary;
  }
}
