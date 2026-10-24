import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { CheckoutSagaConfig } from '@shared/config/checkout-saga.config';
import { toCheckoutSagaStart } from '../checkout-saga-start';
import {
  CHECKOUT_SAGA_ENGINE,
  CheckoutEngineUnavailableError,
  CheckoutSagaClosedError,
  type CheckoutSagaEnginePort,
} from '../ports/checkout-saga-engine.port';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';

const LOG_CONTEXT = 'ReapReservingOrders';
export const REAP_BATCH_SIZE = 50;

export interface ReapSummary {
  found: number;
  handedBack: number;
}

/**
 * A RESERVING order this old has no checkout left waiting on it: tx A committed, then the start never
 * reached Temporal. Starting its saga is enough, since a Try past its budget can only reject it.
 */
@Injectable()
export class ReapReservingOrdersUseCase {
  private readonly orphanMs: number;

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orderRepo: OrderRepositoryPort,
    @Inject(CHECKOUT_SAGA_ENGINE) private readonly engine: CheckoutSagaEnginePort,
    config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
    this.orphanMs = config.getOrThrow<CheckoutSagaConfig>('checkoutSaga').reservingOrphanSec * 1000;
  }

  async execute(): Promise<ReapSummary> {
    const orphans = await this.orderRepo.findReservingOlderThan(new Date(Date.now() - this.orphanMs), REAP_BATCH_SIZE);
    let handedBack = 0;
    for (const [index, order] of orphans.entries()) {
      try {
        await this.engine.ensureStarted(toCheckoutSagaStart(order, 'checkout'));
        handedBack += 1;
      } catch (error) {
        if (error instanceof CheckoutEngineUnavailableError) {
          // Each later order would wait out the same timeout; the next tick tries again.
          this.logger.warn(
            { orderId: order.id, remaining: orphans.length - index, err: error },
            'checkout saga engine unavailable, reaper stopped this batch',
          );
          break;
        }
        if (error instanceof CheckoutSagaClosedError) {
          // The run closed without moving the order off RESERVING: nothing will now, so a person must.
          this.logger.error({ orderId: order.id }, 'RESERVING order whose checkout saga has already closed');
          continue;
        }
        throw error;
      }
    }
    return { found: orphans.length, handedBack };
  }
}
