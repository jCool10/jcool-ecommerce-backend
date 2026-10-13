import {
  ActivityFailure,
  allHandlersFinished,
  ApplicationFailure,
  condition,
  log,
  proxyActivities,
  setHandler,
  TimeoutFailure,
  upsertSearchAttributes,
} from '@temporalio/workflow';
import {
  onAuthorized,
  onCancelRequested,
  onCaptureResult,
  onCommitResult,
  onCompensationResults,
  onDeadline,
  onTryResult,
  type SagaState,
  type SagaTransition,
  type TryVerdict,
} from '../../domain/checkout-saga';
import { CheckoutSagaStep, Compensation } from '../../domain/checkout-saga-step';
import { OrderStatus } from '../../domain/order-status';
import type {
  CheckoutSagaActivities,
  OrderChangeInput,
  OrderWriteResult,
} from '../activities/checkout-saga.activities';
import {
  cancelUpdate,
  CHECKOUT_DEADLINE_ATTRIBUTE,
  CHECKOUT_NOT_CANCELLABLE,
  CHECKOUT_STEP_ATTRIBUTE,
  paymentAuthorizedSignal,
  reserveUpdate,
  stateQuery,
  type CancelRequest,
  type CheckoutSagaInput,
  type CheckoutSagaStart,
  type CheckoutSagaTimings,
  type LateAuthorizationStart,
  type PaymentAuthorizedPayload,
} from '../checkout-saga.contract';

const { RESERVING, AWAITING_AUTH, COMMITTING_STOCK, CAPTURING, COMPLETED, COMPENSATING, COMPENSATED } =
  CheckoutSagaStep;

// The buyer gets the 503 once the release lands or this runs out; the release itself keeps retrying.
const INLINE_RELEASE_WAIT_MS = 1_000;

export async function CheckoutSaga(input: CheckoutSagaInput): Promise<void> {
  if (input.mode === 'lateAuthorization') {
    await voidLateAuthorization(input);
    return;
  }
  await new Checkout(input).run();
}

function activitiesFor({ activityTimeoutMs, retryBaseMs, retryCapMs }: CheckoutSagaTimings): CheckoutSagaActivities {
  return proxyActivities<CheckoutSagaActivities>({
    startToCloseTimeout: activityTimeoutMs,
    // No maximumAttempts: unlimited. Only a non-retryable failure stops a participant call.
    retry: { initialInterval: retryBaseMs, backoffCoefficient: 2, maximumInterval: retryCapMs },
  });
}

function notCancellable(step: CheckoutSagaStep): ApplicationFailure {
  return ApplicationFailure.nonRetryable(`Checkout cannot be cancelled at ${step}`, CHECKOUT_NOT_CANCELLABLE);
}

function setStep(step: CheckoutSagaStep): void {
  upsertSearchAttributes([{ key: CHECKOUT_STEP_ATTRIBUTE, value: step }]);
}

class Checkout {
  private readonly acts: CheckoutSagaActivities;
  private step: CheckoutSagaStep = RESERVING;
  private pending: Compensation[] = [];
  private answer?: TryVerdict;
  private authorization?: PaymentAuthorizedPayload;
  private authorizationHandled = false;
  private readonly seenPayments = new Set<string>();
  private cancelBy?: 'user' | 'admin';
  private cancelApplied = false;
  private compensating = false;
  private readonly running = new Set<Compensation>();
  // A void that was already in flight when a new authorization arrived may have missed it.
  private readonly rerun = new Set<Compensation>();
  private inBackground = 0;
  private failure?: Error;

  constructor(private readonly input: CheckoutSagaStart) {
    this.acts = activitiesFor(input.timings);
    // Registered before the first await: an update or signal can arrive with the start itself.
    setHandler(reserveUpdate, async () => {
      await condition(() => this.answer !== undefined);
      return { verdict: this.answer as TryVerdict };
    });
    setHandler(cancelUpdate, ({ by }) => this.cancel(by), {
      validator: (_request: CancelRequest) => this.assertCancellable(),
    });
    setHandler(paymentAuthorizedSignal, (authorization) => this.onPaymentAuthorized(authorization));
    setHandler(stateQuery, () => ({
      step: this.step,
      pendingCompensations: [...this.pending],
      deadlineAt: input.deadlineAt,
    }));
  }

  async run(): Promise<void> {
    upsertSearchAttributes([
      { key: CHECKOUT_STEP_ATTRIBUTE, value: RESERVING },
      { key: CHECKOUT_DEADLINE_ATTRIBUTE, value: new Date(this.input.deadlineAt) },
    ]);
    const verdict = await this.tryReserve();
    const tried = onTryResult(verdict);
    this.move(tried);
    await this.persist(tried, OrderStatus.RESERVING, (change) =>
      this.acts.applyTryResult({ ...change, verdict, idempotency: this.input.idempotency }),
    );
    this.voidUnhandledAuthorization();
    if (this.step === COMPENSATING) {
      this.startCompensating();
      await condition(() => this.pending.length === 0, INLINE_RELEASE_WAIT_MS);
    }
    this.answer = verdict;

    if (this.step === AWAITING_AUTH) await this.awaitAuthorization();
    if (this.step === COMMITTING_STOCK) await this.settle();
    await this.finish();
  }

  private async tryReserve(): Promise<TryVerdict> {
    const { orderId, lines, holdUntil, placedAt, timings } = this.input;
    const budgetMs = Date.parse(placedAt) + timings.tryTimeoutMs - Date.now();
    if (budgetMs <= 0) return 'ABANDONED';
    const { tryReserve } = proxyActivities<CheckoutSagaActivities>({
      scheduleToCloseTimeout: budgetMs,
      retry: { maximumAttempts: 1 },
    });
    try {
      return await tryReserve({ orderId, lines, holdUntil });
    } catch (error) {
      if (!(error instanceof ActivityFailure)) throw error;
      if (error.cause instanceof TimeoutFailure) return 'TIMEOUT';
      log.warn('Try failed without an answer', { orderId, error: error.cause?.message });
      return 'ERROR';
    }
  }

  private async awaitAuthorization(): Promise<void> {
    const graceEndsAt = Date.parse(this.input.deadlineAt) + this.input.timings.authGraceMs;
    while (this.step === AWAITING_AUTH) {
      const remainingMs = graceEndsAt - Date.now();
      if (remainingMs > 0) {
        await condition(() => this.authorization !== undefined || this.cancelBy !== undefined, remainingMs);
      }

      if (this.cancelBy !== undefined) {
        await this.transition(onCancelRequested(this.state(), this.cancelBy), OrderStatus.PENDING);
        this.cancelApplied = true;
      } else if (this.authorization !== undefined) {
        this.authorizationHandled = true;
        const decision = onAuthorized(this.state(), this.amountMatches(this.authorization));
        if (decision.kind === 'apply') await this.transition(decision.transition, OrderStatus.PENDING);
      } else {
        await this.transition(onDeadline(new Date(), new Date(graceEndsAt)), OrderStatus.PENDING);
      }
    }
    this.voidUnhandledAuthorization();
  }

  /** Capture only ever follows a committed stock, so money is never taken for goods not held. */
  private async settle(): Promise<void> {
    const { orderId } = this.input;
    await this.transition(onCommitResult(await this.acts.commitStock(orderId)), OrderStatus.CONFIRMING);
    if (this.step !== CAPTURING) return;
    await this.transition(onCaptureResult(await this.acts.capturePayment(orderId)), OrderStatus.CONFIRMING);
  }

  private async finish(): Promise<void> {
    for (;;) {
      if (this.step === COMPENSATING) {
        this.startCompensating();
        await condition(() => this.failure !== undefined || this.pending.length === 0);
      }
      this.rethrowBackgroundFailure();
      await condition(() => allHandlersFinished() && this.inBackground === 0);
      this.rethrowBackgroundFailure();
      // A late authorization can reopen a finished compensation while the handlers drain.
      if (this.step !== COMPENSATING) return;
    }
  }

  private rethrowBackgroundFailure(): void {
    if (this.failure) throw this.failure;
  }

  private amountMatches(authorization: PaymentAuthorizedPayload): boolean {
    const matches =
      authorization.amountMinor === this.input.totalMinor && authorization.currency === this.input.currency;
    if (!matches) {
      log.error('payment authorized for different money than the order; failing it and voiding', {
        orderId: this.input.orderId,
        authorized: [authorization.amountMinor, authorization.currency],
        expected: [this.input.totalMinor, this.input.currency],
      });
    }
    return matches;
  }

  private onPaymentAuthorized(authorization: PaymentAuthorizedPayload): void {
    if (this.seenPayments.has(authorization.paymentId)) return;
    this.seenPayments.add(authorization.paymentId);
    if (this.step === COMPENSATING || this.step === COMPENSATED) {
      this.voidLate();
    } else if (this.step === RESERVING || this.step === AWAITING_AUTH) {
      this.authorization ??= authorization;
    }
  }

  /** An authorization taken while the saga was still deciding, which then gave the order up. */
  private voidUnhandledAuthorization(): void {
    if (this.authorization === undefined || this.authorizationHandled) return;
    if (this.step !== COMPENSATING && this.step !== COMPENSATED) return;
    this.authorizationHandled = true;
    this.voidLate();
  }

  private voidLate(): void {
    const decision = onAuthorized(this.state(), true);
    if (decision.kind !== 'apply') return;
    log.warn('payment authorized after the saga gave up; voiding it', { orderId: this.input.orderId });
    this.move(decision.transition);
    if (this.running.has(Compensation.CANCEL_PAYMENT)) this.rerun.add(Compensation.CANCEL_PAYMENT);
    this.launch();
    const { cause } = decision.transition;
    if (cause !== null) this.background(this.acts.recordCompensation(cause));
  }

  private assertCancellable(): void {
    if (this.cancelBy !== undefined) return;
    if (this.step !== AWAITING_AUTH || this.authorization !== undefined) throw notCancellable(this.step);
  }

  private async cancel(by: 'user' | 'admin'): Promise<{ settled: boolean }> {
    this.cancelBy ??= by;
    await condition(() => this.cancelApplied);
    const settled = await condition(() => this.pending.length === 0, this.input.timings.cancelWaitMs);
    return { settled };
  }

  private startCompensating(): void {
    this.compensating = true;
    this.launch();
  }

  /** Each compensation runs on its own: a failing void never holds back the stock release. */
  private launch(): void {
    if (!this.compensating) return;
    for (const compensation of this.pending) {
      if (this.running.has(compensation)) continue;
      this.running.add(compensation);
      this.background(this.runCompensation(compensation));
    }
  }

  private async runCompensation(compensation: Compensation): Promise<void> {
    await this.compensate(compensation, this.input.orderId);
    this.running.delete(compensation);
    if (this.rerun.delete(compensation)) {
      this.launch();
      return;
    }
    this.move(onCompensationResults(this.state(), new Map([[compensation, { kind: 'done' as const }]])));
  }

  private compensate(compensation: Compensation, orderId: string): Promise<void> {
    switch (compensation) {
      case Compensation.RELEASE_STOCK:
        return this.acts.releaseStock(orderId);
      case Compensation.RESTOCK:
        return this.acts.restock(orderId);
      case Compensation.CANCEL_PAYMENT:
        return this.acts.cancelPayment(orderId);
    }
  }

  private async transition(transition: SagaTransition, from: OrderStatus): Promise<void> {
    this.move(transition);
    await this.persist(transition, from);
  }

  /** In memory first: a handler running while the write is in flight already sees the new step. */
  private move({ step, pendingCompensations }: SagaTransition): void {
    if (step !== this.step) setStep(step);
    this.step = step;
    this.pending = [...pendingCompensations];
  }

  private async persist(
    { order, cause }: SagaTransition,
    from: OrderStatus,
    write: (input: OrderChangeInput) => Promise<OrderWriteResult> = (input) => this.acts.applyOrderChange(input),
  ): Promise<void> {
    if (order === null) {
      if (cause !== null) await this.acts.recordCompensation(cause);
      return;
    }
    const result = await write({ orderId: this.input.orderId, from, change: order, cause });
    if (result === 'stale') {
      log.error('order moved outside the saga; carrying on with the saga transition', {
        orderId: this.input.orderId,
        from,
        to: order.status,
      });
    }
  }

  private background(task: Promise<unknown>): void {
    this.inBackground++;
    task.then(
      () => this.inBackground--,
      (error: unknown) => {
        this.inBackground--;
        this.failure ??= error instanceof Error ? error : new Error(String(error));
      },
    );
  }

  private state(): SagaState {
    return { step: this.step, pendingCompensations: this.pending };
  }
}

async function voidLateAuthorization({ orderId, timings }: LateAuthorizationStart): Promise<void> {
  let step: CheckoutSagaStep = COMPENSATING;
  setHandler(paymentAuthorizedSignal, () => undefined);
  setHandler(cancelUpdate, () => Promise.resolve({ settled: true }), {
    validator: (_request: CancelRequest) => {
      throw notCancellable(step);
    },
  });
  setHandler(stateQuery, () => ({
    step,
    pendingCompensations: step === COMPENSATING ? [Compensation.CANCEL_PAYMENT] : [],
    deadlineAt: null,
  }));

  setStep(step);
  const acts = activitiesFor(timings);
  const { status } = await acts.loadLateAuthorizationContext(orderId);
  if (status === OrderStatus.PAID) {
    step = COMPLETED;
    setStep(step);
    return;
  }
  log.warn('payment authorized after the checkout saga closed; voiding it', { orderId, status });
  await acts.cancelPayment(orderId);
  await acts.recordCompensation('late_authorization');
  step = COMPENSATED;
  setStep(step);
}
