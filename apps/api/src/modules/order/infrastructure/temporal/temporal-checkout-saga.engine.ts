import { Inject, Injectable } from '@nestjs/common';
import {
  ApplicationFailure,
  Client,
  WithStartWorkflowOperation,
  WorkflowIdConflictPolicy,
  WorkflowNotFoundError,
  WorkflowUpdateFailedError,
} from '@temporalio/client';
import type { TryVerdict } from '../../domain/checkout-saga';
import {
  CheckoutEngineUnavailableError,
  CheckoutNotCancellableError,
  type CheckoutSagaEnginePort,
  type CheckoutStart,
  type PaymentAuthorization,
} from '../../application/ports/checkout-saga-engine.port';
import { CHECKOUT_SAGA_SETTINGS, type CheckoutSagaSettings } from '../../application/saga/checkout-saga.settings';
import {
  cancelUpdate,
  CHECKOUT_NOT_CANCELLABLE,
  CHECKOUT_SAGA_WORKFLOW,
  paymentAuthorizedSignal,
  RESERVE_UPDATE_ID,
  reserveUpdate,
  workflowIdFor,
  type CheckoutSagaInput,
  type CheckoutSagaTimings,
  type PaymentAuthorizedPayload,
} from '../../saga/checkout-saga.contract';
import type { CheckoutSaga } from '../../saga/workflows/checkout-saga.workflow';
import { TEMPORAL_CLIENT, TEMPORAL_SETTINGS, type TemporalSettings } from './temporal.providers';

// Calls that return as soon as the server has them: only an unreachable server comes near this.
const RPC_TIMEOUT_MS = 10_000;
// Room over the workflow's own wait for the round trips around it.
const CANCEL_CLIENT_SLACK_MS = 5_000;

/**
 * Without a deadline a waiting call blocks for as long as no worker polls the queue. A deadline that
 * runs out only ends the call: the update or start it carried may still go ahead.
 */
@Injectable()
export class TemporalCheckoutSagaEngine implements CheckoutSagaEnginePort {
  constructor(
    @Inject(TEMPORAL_CLIENT) private readonly client: Client,
    @Inject(TEMPORAL_SETTINGS) private readonly temporal: TemporalSettings,
    @Inject(CHECKOUT_SAGA_SETTINGS) private readonly settings: CheckoutSagaSettings,
  ) {}

  async reserve(start: CheckoutStart): Promise<TryVerdict> {
    // The same update id on every attempt, so a retry under the request's key gets the first Try's answer.
    const startWorkflowOperation = new WithStartWorkflowOperation<typeof CheckoutSaga>(CHECKOUT_SAGA_WORKFLOW, {
      ...this.startOptions(start.orderId, this.checkoutInput(start)),
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    });
    try {
      const { verdict } = await this.withDeadline(this.settings.reserveWaitMs, () =>
        this.client.workflow.executeUpdateWithStart(reserveUpdate, {
          startWorkflowOperation,
          updateId: RESERVE_UPDATE_ID,
        }),
      );
      return verdict;
    } catch (error) {
      throw new CheckoutEngineUnavailableError('reserve', { cause: error });
    }
  }

  async cancel(orderId: string, by: 'user' | 'admin'): Promise<'accepted' | 'closed'> {
    try {
      await this.withDeadline(this.settings.cancelWaitMs + CANCEL_CLIENT_SLACK_MS, () =>
        this.client.workflow.getHandle<typeof CheckoutSaga>(workflowIdFor(orderId)).executeUpdate(cancelUpdate, {
          args: [{ by }],
        }),
      );
      return 'accepted';
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) return 'closed';
      if (isRejectedCancel(error)) throw new CheckoutNotCancellableError(orderId);
      throw new CheckoutEngineUnavailableError('cancel', { cause: error });
    }
  }

  async notifyAuthorized(orderId: string, authorization: PaymentAuthorization): Promise<void> {
    const payload: PaymentAuthorizedPayload = {
      paymentId: authorization.paymentId,
      amountMinor: authorization.amountMinor,
      currency: authorization.currency,
      authorizedAt: authorization.authorizedAt.toISOString(),
    };
    try {
      // The default reuse policy is what lets a closed saga's late authorization open a run that voids it.
      await this.withDeadline(RPC_TIMEOUT_MS, () =>
        this.client.workflow.signalWithStart<typeof CheckoutSaga, [PaymentAuthorizedPayload]>(CHECKOUT_SAGA_WORKFLOW, {
          ...this.startOptions(orderId, { mode: 'lateAuthorization', orderId, timings: this.timings() }),
          signal: paymentAuthorizedSignal,
          signalArgs: [payload],
        }),
      );
    } catch (error) {
      throw new CheckoutEngineUnavailableError('notifyAuthorized', { cause: error });
    }
  }

  async ensureStarted(start: CheckoutStart): Promise<void> {
    try {
      await this.withDeadline(RPC_TIMEOUT_MS, () =>
        this.client.workflow.start<typeof CheckoutSaga>(CHECKOUT_SAGA_WORKFLOW, {
          ...this.startOptions(start.orderId, this.checkoutInput(start)),
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        }),
      );
    } catch (error) {
      throw new CheckoutEngineUnavailableError('ensureStarted', { cause: error });
    }
  }

  private withDeadline<T>(timeoutMs: number, call: () => Promise<T>): Promise<T> {
    return this.client.connection.withDeadline(Date.now() + timeoutMs, call);
  }

  private startOptions(orderId: string, input: CheckoutSagaInput) {
    return {
      workflowId: workflowIdFor(orderId),
      taskQueue: this.temporal.taskQueue,
      args: [input] as [CheckoutSagaInput],
    };
  }

  private checkoutInput(start: CheckoutStart): CheckoutSagaInput {
    return {
      mode: 'checkout',
      orderId: start.orderId,
      lines: start.lines,
      totalMinor: start.totalMinor,
      currency: start.currency,
      placedAt: start.placedAt.toISOString(),
      deadlineAt: start.deadlineAt.toISOString(),
      holdUntil: start.holdUntil.toISOString(),
      idempotency: start.idempotency && { scope: start.idempotency.scope, key: start.idempotency.key },
      timings: this.timings(),
    };
  }

  private timings(): CheckoutSagaTimings {
    const { tryTimeoutMs, authGraceMs, cancelWaitMs, activityTimeoutMs, retryBaseMs, retryCapMs } = this.settings;
    return { tryTimeoutMs, authGraceMs, cancelWaitMs, activityTimeoutMs, retryBaseMs, retryCapMs };
  }
}

function isRejectedCancel(error: unknown): boolean {
  return (
    error instanceof WorkflowUpdateFailedError &&
    error.cause instanceof ApplicationFailure &&
    error.cause.type === CHECKOUT_NOT_CANCELLABLE
  );
}
