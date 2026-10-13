import { DomainError } from '@jcool/kernel';
import { CheckoutSagaStep, Compensation, COMPENSATIONS } from './checkout-saga-step';
import { OrderStatus } from './order-status';

const { RESERVING, AWAITING_AUTH, COMMITTING_STOCK, CAPTURING, COMPLETED, COMPENSATING, COMPENSATED } =
  CheckoutSagaStep;
const { RELEASE_STOCK, RESTOCK, CANCEL_PAYMENT } = Compensation;

/** Same strings as the metrics label, so the application layer passes it through untouched. */
export type CompensationCause =
  | 'try_failed'
  | 'expired'
  | 'cancelled'
  | 'commit_conflict'
  | 'capture_failed'
  | 'late_authorization'
  | 'amount_mismatch';

export type OrderChange =
  | { status: typeof OrderStatus.PENDING | typeof OrderStatus.CONFIRMING }
  | {
      status:
        | typeof OrderStatus.REJECTED
        | typeof OrderStatus.PAID
        | typeof OrderStatus.FAILED
        | typeof OrderStatus.EXPIRED
        | typeof OrderStatus.CANCELLED;
      reason: string;
    };

export interface SagaTransition {
  step: CheckoutSagaStep;
  pendingCompensations: readonly Compensation[];
  order: OrderChange | null;
  /** Set only when this transition starts (or adds to) a compensation. */
  cause: CompensationCause | null;
}

export interface SagaState {
  step: CheckoutSagaStep;
  pendingCompensations: readonly Compensation[];
}

/** `TIMEOUT`/`ERROR`: no answer, so a hold may exist. `ABANDONED`: the Try budget ran out before it started. */
export type TryVerdict = 'HELD' | 'OUT_OF_STOCK' | 'CONTENDED' | 'CONFLICT' | 'TIMEOUT' | 'ERROR' | 'ABANDONED';

export type CompensationResult = { kind: 'done' } | { kind: 'conflict' | 'failed'; detail: string };

export type AuthorizationDecision =
  { kind: 'apply'; transition: SagaTransition } | { kind: 'duplicate' } | { kind: 'premature' };

export class CheckoutSagaError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'CheckoutSagaError';
  }
}

function transition(step: CheckoutSagaStep, extra: Partial<Omit<SagaTransition, 'step'>> = {}): SagaTransition {
  return { step, pendingCompensations: [], order: null, cause: null, ...extra };
}

function compensate(
  compensations: readonly Compensation[],
  cause: CompensationCause | null,
  order: OrderChange | null = null,
): SagaTransition {
  return transition(COMPENSATING, { pendingCompensations: asSet(compensations), cause, order });
}

function asSet(compensations: readonly Compensation[]): Compensation[] {
  return COMPENSATIONS.filter((c) => compensations.includes(c));
}

export function onTryResult(verdict: TryVerdict): SagaTransition {
  const rejected = { status: OrderStatus.REJECTED, reason: `try:${verdict.toLowerCase()}` } as const;
  switch (verdict) {
    case 'HELD':
      return transition(AWAITING_AUTH, { order: { status: OrderStatus.PENDING } });
    case 'OUT_OF_STOCK':
    case 'CONTENDED':
    case 'CONFLICT':
      return transition(COMPENSATED, { order: rejected });
    case 'TIMEOUT':
    case 'ERROR':
    case 'ABANDONED':
      return compensate([RELEASE_STOCK], 'try_failed', rejected);
  }
}

/**
 * Authorization can arrive at any step. Once the saga has given up on the order, the money must be
 * voided: commit always runs before capture, so a late one can never be captured on its own.
 */
export function onAuthorized(saga: SagaState, amountMatches: boolean): AuthorizationDecision {
  switch (saga.step) {
    case RESERVING:
      return { kind: 'premature' };
    case AWAITING_AUTH:
      return {
        kind: 'apply',
        transition: amountMatches
          ? transition(COMMITTING_STOCK, { order: { status: OrderStatus.CONFIRMING } })
          : compensate([RELEASE_STOCK, CANCEL_PAYMENT], 'amount_mismatch', {
              status: OrderStatus.FAILED,
              reason: 'payment:amount_mismatch',
            }),
      };
    case COMMITTING_STOCK:
    case CAPTURING:
    case COMPLETED:
      return { kind: 'duplicate' };
    case COMPENSATING:
    case COMPENSATED: {
      const alreadyVoiding = saga.step === COMPENSATING && saga.pendingCompensations.includes(CANCEL_PAYMENT);
      return {
        kind: 'apply',
        transition: compensate(
          [...saga.pendingCompensations, CANCEL_PAYMENT],
          alreadyVoiding ? null : 'late_authorization',
        ),
      };
    }
  }
}

export function onCommitResult(outcome: 'COMMITTED' | 'CONFLICT'): SagaTransition {
  return outcome === 'COMMITTED'
    ? transition(CAPTURING)
    : compensate([CANCEL_PAYMENT], 'commit_conflict', { status: OrderStatus.FAILED, reason: 'stock:commit_conflict' });
}

export function onCaptureResult(outcome: 'CAPTURED' | 'NOT_CAPTURABLE'): SagaTransition {
  return outcome === 'CAPTURED'
    ? transition(COMPLETED, { order: { status: OrderStatus.PAID, reason: 'payment:captured' } })
    : compensate([RESTOCK, CANCEL_PAYMENT], 'capture_failed', {
        status: OrderStatus.FAILED,
        reason: 'payment:not_capturable',
      });
}

/**
 * The gateway stops taking money at the payment deadline; the grace only absorbs a late notice of
 * money taken before it, and the hold outlives the grace.
 */
export function onDeadline(now: Date, graceEndsAt: Date): SagaTransition {
  if (now.getTime() < graceEndsAt.getTime()) {
    return transition(AWAITING_AUTH);
  }
  return compensate([RELEASE_STOCK, CANCEL_PAYMENT], 'expired', {
    status: OrderStatus.EXPIRED,
    reason: 'saga:deadline',
  });
}

export function onCancelRequested(saga: SagaState, by: 'user' | 'admin'): SagaTransition {
  if (saga.step !== AWAITING_AUTH) {
    throw new CheckoutSagaError(`Cannot cancel a checkout saga at ${saga.step}`);
  }
  return compensate([RELEASE_STOCK, CANCEL_PAYMENT], 'cancelled', {
    status: OrderStatus.CANCELLED,
    reason: `${by}:cancel`,
  });
}

/** Each compensation stands alone: one that fails never keeps the others from being dropped. */
export function onCompensationResults(
  saga: SagaState,
  results: ReadonlyMap<Compensation, CompensationResult>,
): SagaTransition {
  const remaining = saga.pendingCompensations.filter((c) => results.get(c)?.kind !== 'done');
  return remaining.length === 0
    ? transition(COMPENSATED)
    : transition(COMPENSATING, { pendingCompensations: asSet(remaining) });
}
