import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApplicationFailure,
  WithStartWorkflowOperation,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  WorkflowUpdateFailedError,
  type Client,
  type WorkflowStartOptions,
} from '@temporalio/client';
import { isRoutableId } from '@jcool/id-codec';
import type { CheckoutSagaConfig } from '../../../../config/checkout-saga.config';
import {
  CheckoutCancelRejectedError,
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
import { type ClosedRunError, toEngineError, withinDeadline } from './temporal-engine-call';
import { TEMPORAL_CLIENT } from './temporal.providers';
import type { CheckoutSaga } from './workflows/checkout-saga.workflow';

// Not a config knob: every caller retries on its own, a queue job or the next reaper or checker tick.
export const START_WAIT_MS = 5000;
const VISIBILITY_WAIT_MS = 5000;
// The checker's batch cap, so one `WorkflowId IN (...)` stays a short query.
export const MAX_VISIBILITY_IDS = 200;

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

  async runningOrderIds(orderIds: string[]): Promise<Set<string>> {
    if (orderIds.length === 0) return new Set();
    if (orderIds.length > MAX_VISIBILITY_IDS) {
      throw new RangeError(`at most ${MAX_VISIBILITY_IDS} order ids per visibility query, got ${orderIds.length}`);
    }
    // Spliced into the query, so only a snowflake gets in.
    const stray = orderIds.find((orderId) => !isRoutableId(orderId));
    if (stray !== undefined) throw new Error(`${JSON.stringify(stray)} is not an order id`);

    const workflowIds = orderIds.map((orderId) => `'${checkoutWorkflowId(orderId)}'`).join(', ');
    const query = `${checkoutSagaRunsOf(this.config.temporal.taskQueue)} AND ExecutionStatus = 'Running' AND WorkflowId IN (${workflowIds})`;
    const prefix = checkoutWorkflowId('');
    return this.call(orderIds[0], VISIBILITY_WAIT_MS, null, async () => {
      const running = new Set<string>();
      for await (const { workflowId } of this.client.workflow.list({ query })) {
        running.add(workflowId.slice(prefix.length));
      }
      return running;
    });
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
      ...(start.tryStartedAt && { tryStartedAt: start.tryStartedAt.toISOString() }),
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
  private call<T>(
    orderId: string,
    waitMs: number,
    closedBy: ClosedRunError | null,
    send: () => Promise<T>,
  ): Promise<T> {
    return withinDeadline(this.client, waitMs, send, (error) =>
      isCancelRejection(error) ? cancelRejectedOf(error, orderId) : toEngineError(error, orderId, closedBy),
    );
  }
}

/** Narrows a visibility query to the sagas of one task queue, never another queue's on the namespace. */
export function checkoutSagaRunsOf(taskQueue: string): string {
  return `WorkflowType = '${CHECKOUT_SAGA_WORKFLOW}' AND TaskQueue = '${taskQueue}'`;
}

type CancelRejection = WorkflowUpdateFailedError & { cause: ApplicationFailure };

function isCancelRejection(error: unknown): error is CancelRejection {
  return (
    error instanceof WorkflowUpdateFailedError &&
    error.cause instanceof ApplicationFailure &&
    error.cause.type === CANCEL_REJECTED_FAILURE
  );
}

function cancelRejectedOf(error: CancelRejection, orderId: string): CheckoutCancelRejectedError {
  const step = error.cause.details?.[0];
  return new CheckoutCancelRejectedError(orderId, CHECKOUT_STEPS.has(step) ? (step as CheckoutStep) : null);
}
