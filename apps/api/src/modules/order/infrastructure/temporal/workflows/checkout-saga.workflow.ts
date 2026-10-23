import {
  ActivityFailure,
  ApplicationFailure,
  TimeoutFailure,
  allHandlersFinished,
  condition,
  log,
  proxyActivities,
  proxyLocalActivities,
  setHandler,
  upsertSearchAttributes,
} from '@temporalio/workflow';
import {
  CheckoutStep,
  canCancel,
  compensationReasonForTry,
  finalizeReasonOf,
  initialCheckoutSagaState,
  onAuthorizationVerified,
  onAuthorized,
  onCancelRequested,
  onCaptureResult,
  onCommitResult,
  onCompensationDone,
  onDeadline,
  onLateAuthorizationContext,
  onTryResult,
  planTry,
  toReserveOutcome,
  type CancelBy,
  type CheckoutSagaState,
  type CompensationCommand,
  type PaymentAuthorization,
  type ReserveOutcome,
  type SagaCommand,
  type Transition,
} from '../../../domain/checkout-saga';
import {
  CANCEL_REJECTED_FAILURE,
  cancelUpdate,
  checkoutStepKey,
  paymentAuthorizedSignal,
  reserveUpdate,
  stateQuery,
  type CheckoutSagaActivityFunctions,
  type CheckoutSagaInput,
  type CheckoutSagaView,
} from '../checkout-saga.contract';

// Handlers change state through the pure transitions at once; what those return is executed here.
// Order changes run first and in order, compensations after them and in parallel. Every activity but
// the Try retries until it lands, so a command only ever finishes by succeeding.

const SETTLED_STEPS: ReadonlySet<CheckoutStep> = new Set([CheckoutStep.COMPLETED, CheckoutStep.COMPENSATED]);

export async function CheckoutSaga(input: CheckoutSagaInput): Promise<CheckoutStep> {
  const { orderId, settings } = input;
  // No maximumAttempts: unset is unlimited (the SDK rejects 0).
  const retried = {
    startToCloseTimeout: settings.activityTimeoutMs,
    retry: { initialInterval: settings.retryBaseMs, backoffCoefficient: 2, maximumInterval: settings.retryCapMs },
  };
  const activities = proxyActivities<CheckoutSagaActivityFunctions>(retried);
  const { applyTryResult } = proxyLocalActivities<CheckoutSagaActivityFunctions>(retried);

  let state = initialCheckoutSagaState(input.mode);
  let inFlight = 0;
  let tryRun: Promise<ReserveOutcome> | undefined;

  const apply = (transition: Transition): void => {
    const before = state.step;
    state = transition.state;
    if (state.step !== before) upsertSearchAttributes([{ key: checkoutStepKey, value: state.step }]);
    if (transition.commands.length > 0) void track(execute(transition.commands));
  };

  const track = async (work: Promise<void>): Promise<void> => {
    inFlight += 1;
    try {
      await work;
    } finally {
      inFlight -= 1;
    }
  };

  const execute = async (commands: readonly SagaCommand[]): Promise<void> => {
    const compensations: CompensationCommand[] = [];
    for (const command of commands) {
      switch (command.type) {
        case 'CHANGE_ORDER': {
          const { type: _type, ...change } = command;
          const written = await activities.applyOrderChange({ orderId, ...change });
          if (written === 'stale') log.warn('saga order change found the order elsewhere', { orderId, to: change.to });
          break;
        }
        case 'VERIFY_AUTHORIZATION':
          void track(verify(command.authorization));
          break;
        // Await before reading state: a handler may have moved it while the activity ran.
        case 'COMMIT_STOCK': {
          const committed = await activities.commitStock({ orderId });
          apply(onCommitResult(state, committed));
          break;
        }
        case 'CAPTURE_PAYMENT': {
          const captured = await activities.capturePayment({ orderId });
          apply(onCaptureResult(state, captured));
          break;
        }
        default:
          compensations.push(command);
      }
    }
    await Promise.all(compensations.map(compensate));
  };

  const compensate = async (command: CompensationCommand): Promise<void> => {
    const compensation = { orderId, reason: command.reason };
    if (command.type === 'RELEASE_STOCK') await activities.releaseStock(compensation);
    else if (command.type === 'RESTOCK') await activities.restock(compensation);
    else await activities.cancelPayment(compensation);
    apply(onCompensationDone(state, command.id));
  };

  const verify = async (authorization: PaymentAuthorization): Promise<void> => {
    const verdict = await activities.verifyAuthorization({ orderId, paymentId: authorization.paymentId });
    const transition = onAuthorizationVerified(state, authorization, verdict);
    if (transition.ignored) {
      log.warn('payment authorization not verified', { orderId, paymentId: authorization.paymentId, verdict });
    }
    apply(transition);
  };

  // Shared by the reserve update and the body, so the Try runs once even if the update is lost.
  const runTry = (): Promise<ReserveOutcome> => (tryRun ??= reserveStock());

  const reserveStock = async (): Promise<ReserveOutcome> => {
    const outcome = await attemptTry();
    const written = await applyTryResult(
      outcome === 'HELD'
        ? { orderId, outcome, reason: null }
        : { orderId, outcome, reason: finalizeReasonOf(compensationReasonForTry(outcome)) },
    );
    if (written === 'stale') log.warn('saga Try result found the order elsewhere', { orderId, outcome });
    apply(onTryResult(state, outcome));
    return outcome;
  };

  const attemptTry = async (): Promise<ReserveOutcome> => {
    const plan = planTry({ placedAt: input.placedAt, tryTimeoutMs: settings.tryTimeoutMs }, Date.now());
    if (plan.abandon) return 'ABANDONED';
    // One attempt: a resent Try could reserve where the first one was refused.
    const { tryReserve } = proxyLocalActivities<CheckoutSagaActivityFunctions>({
      scheduleToCloseTimeout: plan.timeoutMs,
      retry: { maximumAttempts: 1 },
    });
    try {
      return toReserveOutcome(await tryReserve({ orderId, lines: input.lines, holdUntil: input.holdUntil }));
    } catch (error) {
      return error instanceof ActivityFailure && error.cause instanceof TimeoutFailure ? 'TIMEOUT' : 'ERROR';
    }
  };

  setHandler(reserveUpdate, runTry);

  setHandler(
    cancelUpdate,
    async ({ by }) => {
      apply(onCancelRequested(state, by));
      await condition(() => state.step === CheckoutStep.COMPENSATED);
      return 'CANCELLED' as const;
    },
    {
      validator: (_request: { by: CancelBy }) => {
        if (!canCancel(state)) {
          throw ApplicationFailure.create({
            type: CANCEL_REJECTED_FAILURE,
            message: `cancel refused at ${state.step}`,
            details: [state.step],
            nonRetryable: true,
          });
        }
      },
    },
  );

  setHandler(paymentAuthorizedSignal, (authorization) => {
    const transition = onAuthorized(state, authorization, { totalMinor: input.totalMinor, currency: input.currency });
    if (transition.ignored) {
      log.warn('payment authorization ignored', {
        orderId,
        paymentId: authorization.paymentId,
        reason: transition.ignored,
      });
    }
    apply(transition);
  });

  setHandler(stateQuery, () => viewOf(state, input.deadlineAt));

  if (input.mode === 'lateAuthorization') {
    const orderStatus = await activities.loadLateAuthorizationContext({ orderId });
    apply(onLateAuthorizationContext(state, orderStatus));
  } else {
    await runTry();
    const expiresInMs = Date.parse(input.deadlineAt) + settings.authGraceMs - Date.now();
    const settledInTime =
      expiresInMs > 0 && (await condition(() => state.step !== CheckoutStep.AWAITING_AUTH, expiresInMs));
    if (!settledInTime) apply(onDeadline(state));
  }

  await condition(() => SETTLED_STEPS.has(state.step) && inFlight === 0 && allHandlersFinished());
  return state.step;
}

function viewOf(state: CheckoutSagaState, deadlineAt: string): CheckoutSagaView {
  return {
    step: state.step,
    orderStatus: state.orderStatus,
    tryOutcome: state.tryOutcome,
    pendingCompensations: [...state.pending],
    deadlineAt,
  };
}
