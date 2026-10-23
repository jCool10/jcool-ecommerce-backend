import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApplicationFailure,
  ServiceError,
  WithStartWorkflowOperation,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  WorkflowUpdateFailedError,
  WorkflowUpdateRPCTimeoutOrCancelledError,
  type Client,
  type WorkflowStartOptions,
} from '@temporalio/client';
import type { CheckoutSagaConfig } from '@shared/config/checkout-saga.config';
import {
  CheckoutCancelRejectedError,
  CheckoutEngineUnavailableError,
  CheckoutSagaClosedError,
  type CheckoutSagaEnginePort,
  type CheckoutSagaStart,
} from '../../application/ports/checkout-saga-engine.port';
import {
  CheckoutStep,
  type CancelBy,
  type PaymentAuthorization,
  type ReserveOutcome,
} from '../../domain/checkout-saga';
import {
  CANCEL_REJECTED_FAILURE,
  CANCEL_UPDATE_ID,
  CHECKOUT_SAGA_WORKFLOW,
  RESERVE_UPDATE_ID,
  cancelUpdate,
  checkoutDeadlineKey,
  checkoutStepKey,
  checkoutWorkflowId,
  paymentAuthorizedSignal,
  reserveUpdate,
  type CheckoutSagaInput,
} from './checkout-saga.contract';
import { TEMPORAL_CLIENT } from './temporal.providers';
import type { CheckoutSaga } from './workflows/checkout-saga.workflow';

// Not a config knob: both callers retry on their own, a queue job or the reaper's next tick.
const START_WAIT_MS = 5000;

// What a ServiceError's cause carries when Temporal cannot answer now. FAILED_PRECONDITION from
// Update-with-Start means the workflow task keeps failing: retry or investigate, never a refusal.
const UNAVAILABLE_GRPC_CODES = new Set<unknown>([
  4, // DEADLINE_EXCEEDED
  8, // RESOURCE_EXHAUSTED
  9, // FAILED_PRECONDITION
  14, // UNAVAILABLE
]);

const CHECKOUT_STEPS = new Set<unknown>(Object.values(CheckoutStep));

@Injectable()
export class TemporalCheckoutSagaEngine implements CheckoutSagaEnginePort {
  private readonly config: CheckoutSagaConfig;

  constructor(
    @Inject(TEMPORAL_CLIENT) private readonly client: Client,
    config: ConfigService,
  ) {
    this.config = config.getOrThrow<CheckoutSagaConfig>('checkoutSaga');
  }

  reserve(start: CheckoutSagaStart): Promise<ReserveOutcome> {
    const startWorkflowOperation = new WithStartWorkflowOperation<typeof CheckoutSaga>(CHECKOUT_SAGA_WORKFLOW, {
      ...this.startOptions(start),
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      workflowIdConflictPolicy: 'USE_EXISTING',
    });
    return this.call(start.orderId, this.config.reserveWaitMs, WorkflowExecutionAlreadyStartedError, () =>
      this.client.workflow.executeUpdateWithStart(reserveUpdate, {
        updateId: RESERVE_UPDATE_ID,
        startWorkflowOperation,
      }),
    );
  }

  async cancel(orderId: string, by: CancelBy): Promise<void> {
    await this.call(orderId, this.config.cancelWaitMs, WorkflowNotFoundError, () =>
      this.client.workflow
        .getHandle(checkoutWorkflowId(orderId))
        .executeUpdate(cancelUpdate, { args: [{ by }], updateId: CANCEL_UPDATE_ID }),
    );
  }

  async notifyAuthorized(start: CheckoutSagaStart, authorization: PaymentAuthorization): Promise<void> {
    // ALLOW_DUPLICATE opens a new run over a closed one, so no error here means "closed".
    await this.call(start.orderId, START_WAIT_MS, null, () =>
      this.client.workflow.signalWithStart<typeof CheckoutSaga, [PaymentAuthorization]>(CHECKOUT_SAGA_WORKFLOW, {
        ...this.startOptions(start),
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        signal: paymentAuthorizedSignal,
        signalArgs: [authorization],
      }),
    );
  }

  async ensureStarted(start: CheckoutSagaStart): Promise<void> {
    await this.call(start.orderId, START_WAIT_MS, WorkflowExecutionAlreadyStartedError, () =>
      this.client.workflow.start<typeof CheckoutSaga>(CHECKOUT_SAGA_WORKFLOW, {
        ...this.startOptions(start),
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
        workflowIdConflictPolicy: 'USE_EXISTING',
      }),
    );
  }

  private startOptions(start: CheckoutSagaStart): WorkflowStartOptions<typeof CheckoutSaga> {
    return {
      workflowId: checkoutWorkflowId(start.orderId),
      taskQueue: this.config.temporal.taskQueue,
      args: [this.inputOf(start)],
      // Set at start so visibility sees the run before its first workflow task.
      typedSearchAttributes: [
        {
          key: checkoutStepKey,
          value: start.mode === 'checkout' ? CheckoutStep.RESERVING : CheckoutStep.COMPENSATING,
        },
        { key: checkoutDeadlineKey, value: start.deadlineAt },
      ],
    };
  }

  private inputOf(start: CheckoutSagaStart): CheckoutSagaInput {
    const { config } = this;
    return {
      mode: start.mode,
      orderId: start.orderId,
      userId: start.userId,
      lines: start.lines,
      totalMinor: start.totalMinor,
      currency: start.currency,
      placedAt: start.placedAt.toISOString(),
      deadlineAt: start.deadlineAt.toISOString(),
      holdUntil: new Date(start.deadlineAt.getTime() + config.holdSafetySec * 1000).toISOString(),
      settings: {
        tryTimeoutMs: config.tryTimeoutMs,
        authGraceMs: config.authGraceSec * 1000,
        activityTimeoutMs: config.activityTimeoutMs,
        retryBaseMs: config.retryBaseMs,
        retryCapMs: config.retryCapMs,
      },
    };
  }

  /** `closedBy`: the error this call gets from a closed run; the same class elsewhere means something else. */
  private async call<T>(
    orderId: string,
    waitMs: number,
    closedBy: ClosedRunError | null,
    send: () => Promise<T>,
  ): Promise<T> {
    try {
      return await this.client.connection.withDeadline(Date.now() + waitMs, send);
    } catch (error) {
      throw toEngineError(error, orderId, closedBy);
    }
  }
}

type ClosedRunError = typeof WorkflowNotFoundError | typeof WorkflowExecutionAlreadyStartedError;

// By class first: SDK 1.24 wraps gRPC errors in ServiceError and throws an update past its deadline
// as WorkflowUpdateRPCTimeoutOrCancelledError, with no code on the error itself.
function toEngineError(error: unknown, orderId: string, closedBy: ClosedRunError | null): unknown {
  if (error instanceof WorkflowUpdateRPCTimeoutOrCancelledError) {
    return new CheckoutEngineUnavailableError({ cause: error });
  }
  if (error instanceof ServiceError) {
    return UNAVAILABLE_GRPC_CODES.has((error.cause as { code?: unknown } | undefined)?.code)
      ? new CheckoutEngineUnavailableError({ cause: error })
      : error;
  }
  if (
    error instanceof WorkflowUpdateFailedError &&
    error.cause instanceof ApplicationFailure &&
    error.cause.type === CANCEL_REJECTED_FAILURE
  ) {
    const step = error.cause.details?.[0];
    return new CheckoutCancelRejectedError(orderId, CHECKOUT_STEPS.has(step) ? (step as CheckoutStep) : null);
  }
  if (closedBy && error instanceof closedBy) return new CheckoutSagaClosedError(orderId);
  return error;
}
