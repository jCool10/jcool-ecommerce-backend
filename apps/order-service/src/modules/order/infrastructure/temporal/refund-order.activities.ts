import { Inject, Injectable } from '@nestjs/common';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { PinoLogger } from 'nestjs-pino';
import { METRICS, type MetricsPort, type SagaStep, type SagaStepOutcome } from '@jcool/metrics-port';
import {
  ORDER_INVENTORY_PARTICIPANT,
  type OrderInventoryParticipantPort,
} from '../../application/ports/order-inventory-participant.port';
import {
  ORDER_PAYMENT_PARTICIPANT,
  type OrderPaymentParticipantPort,
  type PaymentRefundOutcome,
} from '../../application/ports/order-payment-participant.port';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../../application/ports/order-repository.port';
import { OrderStatus } from '../../domain/order-status';
import { REFUND_CONFLICT_FAILURE, type RefundOrderActivityFunctions } from './refund-order.contract';

const LOG_CONTEXT = 'RefundOrderActivities';

const REFUND_STEP_OUTCOME: Readonly<Record<PaymentRefundOutcome, SagaStepOutcome>> = {
  REFUNDED: 'refunded',
  IDEMPOTENT: 'idempotent',
  PENDING: 'refund_pending',
  REFUND_FAILED: 'refund_failed',
  NOT_REFUNDABLE: 'conflict',
};

/** Same shape as the checkout saga's activities: arrow properties, metrics here, never in the workflow. */
@Injectable()
export class RefundOrderActivities implements RefundOrderActivityFunctions {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepositoryPort,
    @Inject(ORDER_INVENTORY_PARTICIPANT) private readonly inventory: OrderInventoryParticipantPort,
    @Inject(ORDER_PAYMENT_PARTICIPANT) private readonly payment: OrderPaymentParticipantPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  readonly beginRefund: RefundOrderActivityFunctions['beginRefund'] = async ({ orderId }) => {
    const written = await this.orders.applyRefundChange({ orderId, from: OrderStatus.PAID, to: OrderStatus.REFUNDING });
    if (written === 'applied') return 'started';
    if (written === 'already') return 'resumed';
    const status = (await this.orders.findById(orderId))?.status;
    return status === OrderStatus.REFUNDED ? 'already_refunded' : 'not_refundable';
  };

  readonly refundPayment: RefundOrderActivityFunctions['refundPayment'] = async ({ orderId, requestedBy }) => {
    const answer = await this.step(
      'refund_payment',
      () => this.payment.refund(orderId, requestedBy, callOptions()),
      (result) => REFUND_STEP_OUTCOME[result.outcome],
    );
    if (answer.outcome === 'NOT_REFUNDABLE') {
      // The order is REFUNDING, which only a captured payment allows: something moved by hand.
      throw this.conflict(orderId, 'payment-service holds nothing to refund for a refunding order');
    }
    return answer.reason === undefined
      ? { outcome: answer.outcome }
      : { outcome: answer.outcome, reason: answer.reason };
  };

  readonly restockRefundedOrder: RefundOrderActivityFunctions['restockRefundedOrder'] = async ({ orderId }) => {
    const outcome = await this.step(
      'restock',
      () => this.inventory.restock(orderId, callOptions()),
      (result) => result.toLowerCase() as Lowercase<typeof result>,
    );
    if (outcome === 'CONFLICT') throw this.conflict(orderId, 'restock found the stock not committed');
    return outcome;
  };

  readonly abandonRefund: RefundOrderActivityFunctions['abandonRefund'] = ({ orderId }) =>
    this.orders.applyRefundChange({ orderId, from: OrderStatus.REFUNDING, to: OrderStatus.PAID });

  readonly completeRefund: RefundOrderActivityFunctions['completeRefund'] = ({ orderId, requestedBy }) =>
    this.orders.applyRefundChange({ orderId, from: OrderStatus.REFUNDING, to: OrderStatus.REFUNDED, requestedBy });

  private async step<T>(step: SagaStep, call: () => Promise<T>, label: (result: T) => SagaStepOutcome): Promise<T> {
    let result: T;
    try {
      result = await call();
    } catch (error) {
      this.metrics.recordSagaStep(step, 'error');
      throw error;
    }
    this.metrics.recordSagaStep(step, label(result));
    return result;
  }

  // Retried forever on purpose: the run stays visible as stuck instead of settling around it.
  private conflict(orderId: string, message: string): ApplicationFailure {
    this.logger.error({ orderId, conflict: message }, 'refund participant conflict; retrying until resolved by hand');
    return ApplicationFailure.retryable(message, REFUND_CONFLICT_FAILURE);
  }
}

function callOptions(): { signal: AbortSignal } {
  return { signal: Context.current().cancellationSignal };
}
