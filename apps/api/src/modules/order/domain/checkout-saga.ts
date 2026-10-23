import { OrderStatus } from './order-status';

// Pure transitions of the checkout saga. Signal and update handlers call these to change state at
// once; the workflow body only executes the commands they return. Bundled into the workflow, so the
// only import allowed here is another dependency-free domain file (order-status.ts).

export const CheckoutStep = {
  RESERVING: 'RESERVING',
  AWAITING_AUTH: 'AWAITING_AUTH',
  COMMITTING_STOCK: 'COMMITTING_STOCK',
  CAPTURING: 'CAPTURING',
  COMPLETED: 'COMPLETED',
  COMPENSATING: 'COMPENSATING',
  COMPENSATED: 'COMPENSATED',
} as const;
export type CheckoutStep = (typeof CheckoutStep)[keyof typeof CheckoutStep];

export type CheckoutSagaMode = 'checkout' | 'lateAuthorization';

export type ReserveOutcome = 'HELD' | 'OUT_OF_STOCK' | 'CONTENDED' | 'CONFLICT' | 'TIMEOUT' | 'ERROR' | 'ABANDONED';
export type ParticipantTryOutcome = 'RESERVED' | 'OUT_OF_STOCK' | 'CONTENDED' | 'CONFLICT';
export type CommitOutcome = 'APPLIED' | 'IDEMPOTENT' | 'CONFLICT';
/** A capture CONFLICT never gets here: the activity throws it as retryable instead. */
export type SettledCaptureOutcome = 'CAPTURED' | 'IDEMPOTENT' | 'NOT_CAPTURABLE';
export type AuthorizationVerdict = 'VERIFIED' | 'NOT_AUTHORIZED' | 'PAYMENT_MISMATCH';
export type AuthorizationIgnoredReason = 'AMOUNT_MISMATCH' | 'NOT_AUTHORIZED' | 'PAYMENT_MISMATCH';
export type CancelBy = 'buyer' | 'admin';

export const COMPENSATION_REASONS = [
  'TRY_FAILED',
  'TRY_TIMEOUT',
  'ABANDONED',
  'EXPIRED',
  'CANCELLED',
  'COMMIT_CONFLICT',
  'CAPTURE_FAILED',
  'LATE_AUTHORIZATION',
] as const;
export type CompensationReason = (typeof COMPENSATION_REASONS)[number];

export interface PaymentAuthorization {
  paymentId: string;
  amountMinor: number;
  currency: string;
  authorizedAt: string;
}

export interface OrderChangeCommand {
  type: 'CHANGE_ORDER';
  from: OrderStatus[];
  to: OrderStatus;
  reason: string | null;
  paymentRef?: string;
}

export interface CompensationCommand {
  type: 'RELEASE_STOCK' | 'RESTOCK' | 'CANCEL_PAYMENT';
  /** Unique within a run, so the body can report back which one finished. */
  id: number;
  reason: CompensationReason;
}

export type SagaCommand =
  | OrderChangeCommand
  | { type: 'VERIFY_AUTHORIZATION'; authorization: PaymentAuthorization }
  | { type: 'COMMIT_STOCK' }
  | { type: 'CAPTURE_PAYMENT' }
  | CompensationCommand;

export interface CheckoutSagaState {
  readonly mode: CheckoutSagaMode;
  readonly step: CheckoutStep;
  /** What the saga last wrote to the order; null in a late-authorization run until it has read it. */
  readonly orderStatus: OrderStatus | null;
  readonly tryOutcome: ReserveOutcome | null;
  /** The authorization that passed verification. */
  readonly authorization: PaymentAuthorization | null;
  readonly verifying: readonly string[];
  /** Authorizations a late CANCEL_PAYMENT was already issued for. */
  readonly voided: readonly string[];
  readonly pending: readonly CompensationCommand[];
  readonly nextCommandId: number;
}

export interface Transition {
  state: CheckoutSagaState;
  commands: readonly SagaCommand[];
}

export interface AuthorizationTransition extends Transition {
  ignored: AuthorizationIgnoredReason | null;
}

export function initialCheckoutSagaState(mode: CheckoutSagaMode): CheckoutSagaState {
  return {
    mode,
    step: mode === 'checkout' ? CheckoutStep.RESERVING : CheckoutStep.COMPENSATING,
    orderStatus: mode === 'checkout' ? OrderStatus.RESERVING : null,
    tryOutcome: null,
    authorization: null,
    verifying: [],
    voided: [],
    pending: [],
    nextCommandId: 1,
  };
}

/** The budget runs from placedAt, not from when the workflow got around to the Try. */
export function planTry(
  input: { placedAt: string; tryTimeoutMs: number },
  nowMs: number,
): { abandon: true } | { abandon: false; timeoutMs: number } {
  const remaining = Date.parse(input.placedAt) + input.tryTimeoutMs - nowMs;
  return remaining > 0 ? { abandon: false, timeoutMs: remaining } : { abandon: true };
}

export function toReserveOutcome(outcome: ParticipantTryOutcome): ReserveOutcome {
  return outcome === 'RESERVED' ? 'HELD' : outcome;
}

export function compensationReasonForTry(outcome: Exclude<ReserveOutcome, 'HELD'>): CompensationReason {
  switch (outcome) {
    case 'TIMEOUT':
    case 'ERROR':
      return 'TRY_TIMEOUT';
    case 'ABANDONED':
      return 'ABANDONED';
    default:
      return 'TRY_FAILED';
  }
}

export function finalizeReasonOf(reason: CompensationReason): string {
  return `saga:${reason.toLowerCase()}`;
}

export function onTryResult(state: CheckoutSagaState, outcome: ReserveOutcome): Transition {
  if (state.step !== CheckoutStep.RESERVING) return noop(state);
  if (outcome === 'HELD') {
    return {
      state: { ...state, step: CheckoutStep.AWAITING_AUTH, orderStatus: OrderStatus.PENDING, tryOutcome: outcome },
      commands: [],
    };
  }
  const tried = { ...state, orderStatus: OrderStatus.REJECTED, tryOutcome: outcome };
  return compensate(tried, [], [['RELEASE_STOCK', compensationReasonForTry(outcome)]]);
}

export function onAuthorized(
  state: CheckoutSagaState,
  authorization: PaymentAuthorization,
  expected: { totalMinor: number; currency: string },
): AuthorizationTransition {
  const { paymentId } = authorization;

  if (state.step === CheckoutStep.COMPENSATING || state.step === CheckoutStep.COMPENSATED) {
    if (state.voided.includes(paymentId)) return ignored(state, null);
    const seen = { ...state, voided: [...state.voided, paymentId] };
    // A late-authorization run voids only once it knows the order was not paid.
    if (state.mode === 'lateAuthorization' && state.orderStatus === null) return ignored(seen, null);
    return { ...compensate(seen, [], [['CANCEL_PAYMENT', 'LATE_AUTHORIZATION']]), ignored: null };
  }
  if (state.step !== CheckoutStep.AWAITING_AUTH) return ignored(state, null);

  if (authorization.amountMinor !== expected.totalMinor || authorization.currency !== expected.currency) {
    return ignored(state, 'AMOUNT_MISMATCH');
  }
  if (state.verifying.includes(paymentId)) return ignored(state, null);
  return {
    state: { ...state, verifying: [...state.verifying, paymentId] },
    commands: [{ type: 'VERIFY_AUTHORIZATION', authorization }],
    ignored: null,
  };
}

export function onAuthorizationVerified(
  state: CheckoutSagaState,
  authorization: PaymentAuthorization,
  verdict: AuthorizationVerdict,
): AuthorizationTransition {
  const settled = { ...state, verifying: state.verifying.filter((id) => id !== authorization.paymentId) };
  // Cancel or the deadline won while the check ran; their compensation already voids the payment.
  if (state.step !== CheckoutStep.AWAITING_AUTH) return ignored(state, null);
  if (verdict !== 'VERIFIED') return ignored(settled, verdict);
  return {
    state: { ...settled, step: CheckoutStep.COMMITTING_STOCK, orderStatus: OrderStatus.CONFIRMING, authorization },
    commands: [changeOrder(OrderStatus.PENDING, OrderStatus.CONFIRMING, null), { type: 'COMMIT_STOCK' }],
    ignored: null,
  };
}

export function onCommitResult(state: CheckoutSagaState, outcome: CommitOutcome): Transition {
  if (state.step !== CheckoutStep.COMMITTING_STOCK) return noop(state);
  if (outcome === 'CONFLICT') {
    return compensate(
      { ...state, orderStatus: OrderStatus.FAILED },
      [changeOrder(OrderStatus.CONFIRMING, OrderStatus.FAILED, finalizeReasonOf('COMMIT_CONFLICT'))],
      [['CANCEL_PAYMENT', 'COMMIT_CONFLICT']],
    );
  }
  return { state: { ...state, step: CheckoutStep.CAPTURING }, commands: [{ type: 'CAPTURE_PAYMENT' }] };
}

export function onCaptureResult(state: CheckoutSagaState, outcome: SettledCaptureOutcome): Transition {
  if (state.step !== CheckoutStep.CAPTURING) return noop(state);
  if (outcome === 'NOT_CAPTURABLE') {
    return compensate(
      { ...state, orderStatus: OrderStatus.FAILED },
      [changeOrder(OrderStatus.CONFIRMING, OrderStatus.FAILED, finalizeReasonOf('CAPTURE_FAILED'))],
      [
        ['RESTOCK', 'CAPTURE_FAILED'],
        ['CANCEL_PAYMENT', 'CAPTURE_FAILED'],
      ],
    );
  }
  const paid: OrderChangeCommand = {
    ...changeOrder(OrderStatus.CONFIRMING, OrderStatus.PAID, 'saga:captured'),
    paymentRef: state.authorization?.paymentId,
  };
  return { state: { ...state, step: CheckoutStep.COMPLETED, orderStatus: OrderStatus.PAID }, commands: [paid] };
}

export function onDeadline(state: CheckoutSagaState): Transition {
  if (state.step !== CheckoutStep.AWAITING_AUTH) return noop(state);
  return compensate(
    { ...state, orderStatus: OrderStatus.EXPIRED },
    [changeOrder(OrderStatus.PENDING, OrderStatus.EXPIRED, finalizeReasonOf('EXPIRED'))],
    [
      ['RELEASE_STOCK', 'EXPIRED'],
      ['CANCEL_PAYMENT', 'EXPIRED'],
    ],
  );
}

export function canCancel(state: CheckoutSagaState): boolean {
  return state.step === CheckoutStep.AWAITING_AUTH || state.orderStatus === OrderStatus.CANCELLED;
}

export function onCancelRequested(state: CheckoutSagaState, by: CancelBy): Transition {
  if (state.step !== CheckoutStep.AWAITING_AUTH) return noop(state);
  // Same reasons the legacy cancel route writes, so the two read alike.
  const reason = by === 'buyer' ? 'user:cancel' : 'admin:cancel';
  return compensate(
    { ...state, orderStatus: OrderStatus.CANCELLED },
    [changeOrder(OrderStatus.PENDING, OrderStatus.CANCELLED, reason)],
    [
      ['RELEASE_STOCK', 'CANCELLED'],
      ['CANCEL_PAYMENT', 'CANCELLED'],
    ],
  );
}

export function onCompensationDone(state: CheckoutSagaState, id: number): Transition {
  if (!state.pending.some((command) => command.id === id)) return noop(state);
  const pending = state.pending.filter((command) => command.id !== id);
  const step = pending.length === 0 ? CheckoutStep.COMPENSATED : state.step;
  return { state: { ...state, pending, step }, commands: [] };
}

/** Decides a late-authorization run once it has read the order; the order itself is never changed. */
export function onLateAuthorizationContext(state: CheckoutSagaState, orderStatus: OrderStatus | null): Transition {
  if (state.mode !== 'lateAuthorization' || state.orderStatus !== null) return noop(state);
  // null would read as "not loaded yet", so a missing order is recorded as REJECTED: never placed.
  const known = { ...state, orderStatus: orderStatus ?? OrderStatus.REJECTED };
  if (orderStatus === OrderStatus.PAID) {
    return { state: { ...known, step: CheckoutStep.COMPLETED }, commands: [] };
  }
  return compensate(known, [], [['CANCEL_PAYMENT', 'LATE_AUTHORIZATION']]);
}

function compensate(
  state: CheckoutSagaState,
  first: readonly SagaCommand[],
  compensations: ReadonlyArray<[CompensationCommand['type'], CompensationReason]>,
): Transition {
  let nextCommandId = state.nextCommandId;
  const issued = compensations.map(([type, reason]): CompensationCommand => ({ type, id: nextCommandId++, reason }));
  return {
    state: { ...state, step: CheckoutStep.COMPENSATING, pending: [...state.pending, ...issued], nextCommandId },
    commands: [...first, ...issued],
  };
}

function changeOrder(from: OrderStatus, to: OrderStatus, reason: string | null): OrderChangeCommand {
  return { type: 'CHANGE_ORDER', from: [from], to, reason };
}

function noop(state: CheckoutSagaState): Transition {
  return { state, commands: [] };
}

function ignored(state: CheckoutSagaState, reason: AuthorizationIgnoredReason | null): AuthorizationTransition {
  return { state, commands: [], ignored: reason };
}
