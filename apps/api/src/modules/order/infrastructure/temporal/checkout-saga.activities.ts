import { Inject, Injectable } from '@nestjs/common';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { PinoLogger } from 'nestjs-pino';
import {
  METRICS,
  type CompensationKind,
  type CompensationReason as CompensationReasonLabel,
  type MetricsPort,
  type SagaStep,
  type SagaStepOutcome,
} from '@jcool/metrics-port';
import type { CompensationReason } from '../../domain/checkout-saga';
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

type ParticipantAnswer = Uppercase<Exclude<SagaStepOutcome, 'error'>>;

// The answers that mean this attempt did the compensating; IDEMPOTENT is a retry finding it done.
const COMPENSATED: ReadonlySet<ParticipantAnswer> = new Set(['APPLIED', 'CANCELLED', 'FENCED']);

/**
 * Arrow properties so the instance itself is the worker's activity map. Each one reaches its port at
 * call time, never through a reference taken earlier, so a test that patches the port still lands.
 * Metrics are recorded here rather than in the workflow, whose code replays.
 */
@Injectable()
export class CheckoutSagaActivities implements CheckoutSagaActivityFunctions {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepositoryPort,
    @Inject(ORDER_INVENTORY_PARTICIPANT) private readonly inventory: OrderInventoryParticipantPort,
    @Inject(ORDER_PAYMENT_PARTICIPANT) private readonly payment: OrderPaymentParticipantPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  readonly tryReserve: CheckoutSagaActivityFunctions['tryReserve'] = ({ orderId, lines, holdUntil }) =>
    this.step('try_reserve', () =>
      this.inventory.tryReserve({ orderId, lines, holdUntil: new Date(holdUntil) }, callOptions()),
    );

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
    this.step('commit_stock', () => this.inventory.commit(orderId, callOptions()));

  readonly capturePayment: CheckoutSagaActivityFunctions['capturePayment'] = async ({ orderId }) => {
    const outcome = await this.step('capture_payment', () => this.payment.capture(orderId, callOptions()));
    if (outcome === 'CONFLICT') {
      // Only reachable after a verified authorization, so this is a bug, not a business answer.
      throw this.conflict({ orderId }, 'capture found nothing authorized after verification', 'CaptureConflict');
    }
    return outcome;
  };

  readonly releaseStock: CheckoutSagaActivityFunctions['releaseStock'] = async (input) => {
    const outcome = await this.compensation('release_stock', input, () =>
      this.inventory.release(input.orderId, callOptions()),
    );
    if (outcome === 'CONFLICT') {
      throw this.conflict(input, 'stock release conflicts with the hold', 'CompensationConflict');
    }
  };

  readonly restock: CheckoutSagaActivityFunctions['restock'] = async (input) => {
    const outcome = await this.compensation('restock', input, () =>
      this.inventory.restock(input.orderId, callOptions()),
    );
    if (outcome === 'CONFLICT') {
      throw this.conflict(input, 'restock conflicts with the hold', 'CompensationConflict');
    }
  };

  readonly cancelPayment: CheckoutSagaActivityFunctions['cancelPayment'] = async (input) => {
    const outcome = await this.compensation('cancel_payment', input, () =>
      this.payment.cancel(input.orderId, callOptions()),
    );
    if (outcome === 'CAPTURED_CONFLICT') {
      throw this.conflict(input, 'payment void found the money already captured', 'CompensationConflict');
    }
  };

  readonly loadLateAuthorizationContext: CheckoutSagaActivityFunctions['loadLateAuthorizationContext'] = async ({
    orderId,
  }) => (await this.orders.findById(orderId))?.status ?? null;

  private async step<T extends ParticipantAnswer>(step: SagaStep, call: () => Promise<T>): Promise<T> {
    let outcome: T;
    try {
      outcome = await call();
    } catch (error) {
      this.metrics.recordSagaStep(step, 'error');
      throw error;
    }
    this.metrics.recordSagaStep(step, outcome.toLowerCase() as SagaStepOutcome);
    return outcome;
  }

  private async compensation<T extends ParticipantAnswer>(
    kind: CompensationKind,
    { reason }: CompensationInput,
    call: () => Promise<T>,
  ): Promise<T> {
    const outcome = await this.step(kind, call);
    if (COMPENSATED.has(outcome)) this.metrics.recordCompensation(kind, labelOf(reason));
    return outcome;
  }

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

const labelOf = (reason: CompensationReason): CompensationReasonLabel =>
  reason.toLowerCase() as Lowercase<CompensationReason>;
