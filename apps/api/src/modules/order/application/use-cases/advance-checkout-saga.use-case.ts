import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { METRICS, type MetricsPort, type SagaStep } from '@jcool/metrics-port';
import { CheckoutSagaStep, Compensation } from '../../domain/checkout-saga-step';
import {
  onCaptureResult,
  onCommitResult,
  onCompensationResults,
  onDeadline,
  onStepFailed,
  onTryResult,
  type CompensationResult,
  type SagaTransition,
} from '../../domain/checkout-saga';
import {
  CHECKOUT_SAGA_REPOSITORY,
  type CheckoutSaga,
  type CheckoutSagaRepositoryPort,
} from '../ports/checkout-saga-repository.port';
import { INVENTORY_TCC, type InventoryTccPort } from '../ports/inventory-participant.port';
import { PAYMENT_TCC, type PaymentTccPort } from '../ports/payment-participant.port';
import { CHECKOUT_SAGA_SETTINGS, type CheckoutSagaSettings } from '../saga/checkout-saga.settings';
import { CheckoutSagaWriter } from '../saga/checkout-saga.writer';

const LOG_CONTEXT = 'AdvanceCheckoutSaga';
/** The longest real path is three applies; the bound only keeps a bug from spinning on one saga. */
const MAX_STEPS = 8;
const MAX_ERROR_LENGTH = 500;

type CompensationOutcome =
  | Awaited<ReturnType<InventoryTccPort['release']>>
  | Awaited<ReturnType<InventoryTccPort['restock']>>
  | Awaited<ReturnType<PaymentTccPort['cancel']>>;

/** A record, not a set, so a new participant outcome fails the build until it is classified here. */
const SETTLES: Record<CompensationOutcome, boolean> = {
  RELEASED: true,
  RESTOCKED: true,
  CANCELLED: true,
  FENCED: true,
  CONFLICT: false,
  CAPTURED_CONFLICT: false,
};

/** Null when the lease was lost mid-step: whoever moved the saga owns it now. */
type Decided = { lease: CheckoutSaga; transition: SagaTransition } | null;

/**
 * Drives one saga until it parks, backs off, finishes, or loses it to another write. Kick, cancel,
 * the inline release after a failed Try and the runner all come through here; the conditional claim
 * is the only thing keeping two of them off one saga.
 */
@Injectable()
export class AdvanceCheckoutSagaUseCase {
  constructor(
    @Inject(CHECKOUT_SAGA_REPOSITORY) private readonly sagas: CheckoutSagaRepositoryPort,
    private readonly writer: CheckoutSagaWriter,
    @Inject(INVENTORY_TCC) private readonly inventory: InventoryTccPort,
    @Inject(PAYMENT_TCC) private readonly payment: PaymentTccPort,
    @Inject(CHECKOUT_SAGA_SETTINGS) private readonly settings: CheckoutSagaSettings,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async execute(orderId: string): Promise<void> {
    for (let steps = 0; steps < MAX_STEPS; steps++) {
      const claimed = await this.sagas.claim(orderId, this.settings.leaseMs);
      if (!claimed) return;
      const decided = await this.decide(claimed);
      if (!decided) return;
      const applied = await this.writer.applyLeased(decided.lease, decided.transition);
      if (!applied || decided.transition.wake !== 'now') return;
    }
    this.logger.warn({ orderId, maxSteps: MAX_STEPS }, 'checkout saga still has work after the step bound');
  }

  private async decide(lease: CheckoutSaga): Promise<Decided> {
    switch (lease.step) {
      case CheckoutSagaStep.RESERVING:
        // Claimable only once the lease taken at insert ran out, so the request that took it is gone.
        this.metrics.recordSagaStep('try_reserve', 'failed');
        return { lease, transition: onTryResult('ABANDONED') };
      case CheckoutSagaStep.AWAITING_AUTH:
        return { lease, transition: onDeadline(lease, new Date(), this.settings.timing) };
      case CheckoutSagaStep.COMMITTING_STOCK:
        return this.call(lease, 'commit_stock', () => this.inventory.commit(lease.orderId), onCommitResult);
      case CheckoutSagaStep.CAPTURING:
        return this.call(lease, 'capture', () => this.payment.capture(lease.orderId), onCaptureResult);
      case CheckoutSagaStep.COMPENSATING:
        return this.compensate(lease);
      case CheckoutSagaStep.COMPLETED:
      case CheckoutSagaStep.COMPENSATED:
        return null;
    }
  }

  private async call<A>(
    lease: CheckoutSaga,
    step: SagaStep,
    invoke: () => Promise<A>,
    decide: (answer: A) => SagaTransition,
  ): Promise<Decided> {
    const held = await this.renew(lease);
    if (!held) return null;
    let answer: A;
    try {
      answer = await invoke();
    } catch (error) {
      this.metrics.recordSagaStep(step, 'failed');
      return { lease: held, transition: onStepFailed(held, describe(error)) };
    }
    const transition = decide(answer);
    this.metrics.recordSagaStep(step, transition.cause === null ? 'success' : 'failed');
    return { lease: held, transition };
  }

  /** Every pending compensation is tried on each pass; one failing never holds back the others. */
  private async compensate(lease: CheckoutSaga): Promise<Decided> {
    let held = lease;
    const results = new Map<Compensation, CompensationResult>();
    for (const compensation of lease.pendingCompensations) {
      const renewed = await this.renew(held);
      if (!renewed) return null;
      held = renewed;
      const result = await this.runCompensation(lease.orderId, compensation);
      this.metrics.recordSagaStep('compensate', result.kind === 'done' ? 'success' : 'failed');
      if (result.kind === 'conflict') {
        this.logger.error(
          { orderId: lease.orderId, compensation, outcome: result.detail },
          'compensation conflicts with participant state and will keep retrying until resolved by hand',
        );
      }
      results.set(compensation, result);
    }
    return { lease: held, transition: onCompensationResults(held, results) };
  }

  private async runCompensation(orderId: string, compensation: Compensation): Promise<CompensationResult> {
    let outcome: CompensationOutcome;
    try {
      outcome = await this.invokeCompensation(orderId, compensation);
    } catch (error) {
      return { kind: 'failed', detail: describe(error) };
    }
    return SETTLES[outcome] ? { kind: 'done' } : { kind: 'conflict', detail: outcome };
  }

  private invokeCompensation(orderId: string, compensation: Compensation): Promise<CompensationOutcome> {
    switch (compensation) {
      case Compensation.RELEASE_STOCK:
        return this.inventory.release(orderId);
      case Compensation.RESTOCK:
        return this.inventory.restock(orderId);
      case Compensation.CANCEL_PAYMENT:
        return this.payment.cancel(orderId);
    }
  }

  private async renew(lease: CheckoutSaga): Promise<CheckoutSaga | null> {
    const version = await this.sagas.renew(lease.orderId, lease.version, this.settings.leaseMs);
    return version === null ? null : { ...lease, version };
  }
}

/** `last_error` keeps the error's name and message only: never a stack, a cause or a payload. */
function describe(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, MAX_ERROR_LENGTH);
}
