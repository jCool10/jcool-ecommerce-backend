import { Inject, Injectable } from '@nestjs/common';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { PinoLogger } from 'nestjs-pino';
import {
  ORDER_INVENTORY_PARTICIPANT,
  type OrderInventoryParticipantPort,
} from '../../application/ports/order-inventory-participant.port';
import {
  ORDER_PAYMENT_PARTICIPANT,
  type OrderPaymentParticipantPort,
} from '../../application/ports/order-payment-participant.port';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../../application/ports/order-repository.port';
import type { CheckoutSagaActivityFunctions, CompensationInput } from './checkout-saga.contract';

const LOG_CONTEXT = 'CheckoutSagaActivities';

/**
 * Arrow properties so the instance itself is the worker's activity map. Each one reaches its port at
 * call time, never through a reference taken earlier, so a test that patches the port still lands.
 */
@Injectable()
export class CheckoutSagaActivities implements CheckoutSagaActivityFunctions {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepositoryPort,
    @Inject(ORDER_INVENTORY_PARTICIPANT) private readonly inventory: OrderInventoryParticipantPort,
    @Inject(ORDER_PAYMENT_PARTICIPANT) private readonly payment: OrderPaymentParticipantPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  readonly tryReserve: CheckoutSagaActivityFunctions['tryReserve'] = ({ orderId, lines, holdUntil }) =>
    this.inventory.tryReserve({ orderId, lines, holdUntil: new Date(holdUntil) }, callOptions());

  readonly applyTryResult: CheckoutSagaActivityFunctions['applyTryResult'] = (input) =>
    this.orders.applyTryResult(input);

  readonly applyOrderChange: CheckoutSagaActivityFunctions['applyOrderChange'] = (input) =>
    this.orders.applyOrderChange(input);

  readonly verifyAuthorization: CheckoutSagaActivityFunctions['verifyAuthorization'] = async ({
    orderId,
    paymentId,
  }) => {
    const status = (await this.payment.statusOf([orderId], callOptions())).get(orderId);
    if (status?.header !== 'AUTHORIZED') return 'NOT_AUTHORIZED';
    return status.authorizedPaymentId === paymentId ? 'VERIFIED' : 'PAYMENT_MISMATCH';
  };

  readonly commitStock: CheckoutSagaActivityFunctions['commitStock'] = ({ orderId }) =>
    this.inventory.commit(orderId, callOptions());

  readonly capturePayment: CheckoutSagaActivityFunctions['capturePayment'] = async ({ orderId }) => {
    const outcome = await this.payment.capture(orderId, callOptions());
    if (outcome === 'CONFLICT') {
      // Only reachable after a verified authorization, so this is a bug, not a business answer.
      throw this.conflict({ orderId }, 'capture found nothing authorized after verification', 'CaptureConflict');
    }
    return outcome;
  };

  readonly releaseStock: CheckoutSagaActivityFunctions['releaseStock'] = async (input) => {
    if ((await this.inventory.release(input.orderId, callOptions())) === 'CONFLICT') {
      throw this.conflict(input, 'stock release conflicts with the hold', 'CompensationConflict');
    }
  };

  readonly restock: CheckoutSagaActivityFunctions['restock'] = async (input) => {
    if ((await this.inventory.restock(input.orderId, callOptions())) === 'CONFLICT') {
      throw this.conflict(input, 'restock conflicts with the hold', 'CompensationConflict');
    }
  };

  readonly cancelPayment: CheckoutSagaActivityFunctions['cancelPayment'] = async (input) => {
    if ((await this.payment.cancel(input.orderId, callOptions())) === 'CAPTURED_CONFLICT') {
      throw this.conflict(input, 'payment void found the money already captured', 'CompensationConflict');
    }
  };

  readonly loadLateAuthorizationContext: CheckoutSagaActivityFunctions['loadLateAuthorizationContext'] = async ({
    orderId,
  }) => (await this.orders.findById(orderId))?.status ?? null;

  // Retried forever on purpose: the saga cannot settle around it, so it stays visible as stuck.
  private conflict(
    context: { orderId: string } | CompensationInput,
    message: string,
    type: string,
  ): ApplicationFailure {
    this.logger.error({ ...context, conflict: message }, 'saga participant conflict; retrying until resolved by hand');
    return ApplicationFailure.retryable(message, type);
  }
}

function callOptions(): { signal: AbortSignal } {
  return { signal: Context.current().cancellationSignal };
}
