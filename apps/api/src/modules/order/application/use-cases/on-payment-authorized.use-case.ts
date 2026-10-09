import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { onAuthorized } from '../../domain/checkout-saga';
import { CHECKOUT_SAGA_REPOSITORY, type CheckoutSagaRepositoryPort } from '../ports/checkout-saga-repository.port';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';
import { CheckoutSagaWriter } from '../saga/checkout-saga.writer';
import { SagaKickExecutor } from '../saga/saga-kick.executor';

const LOG_CONTEXT = 'OnPaymentAuthorized';

export interface PaymentAuthorized {
  orderId: string;
  amountMinor: number;
  currency: string;
}

/** Retryable on purpose: the request that inserted the saga is still waiting on its Try. */
export class AuthorizationBeforePlacementError extends Error {
  constructor(orderId: string) {
    super(`Payment authorized for order ${orderId} before its Try settled`);
    this.name = 'AuthorizationBeforePlacementError';
  }
}

/**
 * Runs in the consumer's transaction, next to its inbox claim. Returns what must wait for that
 * transaction to commit, or null when there is nothing to apply.
 */
@Injectable()
export class OnPaymentAuthorizedUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepositoryPort,
    @Inject(CHECKOUT_SAGA_REPOSITORY) private readonly sagas: CheckoutSagaRepositoryPort,
    private readonly writer: CheckoutSagaWriter,
    private readonly kicks: SagaKickExecutor,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async execute(event: PaymentAuthorized, tx: DrizzleTx, eventId: string): Promise<(() => void) | null> {
    const { orderId } = event;
    const order = await this.orders.findByIdForUpdate(orderId, tx);
    const saga = order ? await this.sagas.findForUpdate(tx, orderId) : null;
    if (!order || !saga) {
      // Acknowledged: no redelivery conjures the saga, and money authorized for nothing is a refund decision.
      this.logger.error({ orderId, hasOrder: order !== null }, 'payment authorized for an order with no checkout saga');
      return null;
    }

    const amountMatches = event.amountMinor === order.totalAmountMinor && event.currency === order.currency;
    const decision = onAuthorized(saga, amountMatches);
    switch (decision.kind) {
      case 'premature':
        throw new AuthorizationBeforePlacementError(orderId);
      case 'duplicate':
        return null;
      case 'apply': {
        const { transition } = decision;
        if (!amountMatches) {
          this.logger.error(
            {
              orderId,
              authorized: [event.amountMinor, event.currency],
              expected: [order.totalAmountMinor, order.currency],
            },
            'payment authorized for different money than the order; failing it and voiding',
          );
        } else if (transition.cause === 'late_authorization') {
          this.logger.warn({ orderId, step: saga.step }, 'payment authorized after the saga gave up; voiding it');
        }
        await this.writer.rewrite(tx, order, saga, transition, { now: new Date(), eventId });
        return () => {
          this.writer.reportCommitted(transition);
          this.kicks.submit(orderId);
        };
      }
    }
  }
}
