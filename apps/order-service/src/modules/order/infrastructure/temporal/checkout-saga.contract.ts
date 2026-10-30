import { defineSearchAttributeKey } from '@temporalio/common';
import { defineQuery, defineSignal, defineUpdate } from '@temporalio/workflow';
import type {
  AuthorizationVerdict,
  CancelBy,
  CheckoutSagaMode,
  CheckoutStep,
  CommitOutcome,
  CompensationCommand,
  CompensationReason,
  ParticipantTryOutcome,
  PaymentAuthorization,
  ReserveOutcome,
  SettledCaptureOutcome,
} from '../../domain/checkout-saga';
import type { OrderStatus } from '../../domain/order-status';
import type {
  ApplyOrderChangeInput,
  ApplyTryResultInput,
  SagaWriteResult,
} from '../../application/ports/order-repository.port';

// Shared by the workflow bundle, the worker and the client. Runtime imports stay limited to the two
// Temporal packages that are safe inside the workflow sandbox.

export const CHECKOUT_SAGA_WORKFLOW = 'CheckoutSaga';

export const checkoutWorkflowId = (orderId: string): string => `checkout-${orderId}`;

export const RESERVE_UPDATE_ID = 'reserve';
export const CANCEL_UPDATE_ID = 'cancel';

/** ApplicationFailure type the cancel validator rejects with; `details[0]` is the step. */
export const CANCEL_REJECTED_FAILURE = 'CancelRejected';

export const checkoutStepKey = defineSearchAttributeKey('CheckoutStep', 'KEYWORD');
export const checkoutDeadlineKey = defineSearchAttributeKey('CheckoutDeadlineAt', 'DATETIME');

/** Snapshotted from config when the run starts; the workflow never reads env. */
export interface CheckoutSagaSettings {
  tryTimeoutMs: number;
  authGraceMs: number;
  activityTimeoutMs: number;
  retryBaseMs: number;
  retryCapMs: number;
}

export interface CheckoutSagaLine {
  skuId: string;
  quantity: number;
}

/** Timestamps are ISO strings: the payload is JSON. No PII or card data. */
export interface CheckoutSagaInput {
  mode: CheckoutSagaMode;
  orderId: string;
  userId: string;
  lines: CheckoutSagaLine[];
  totalMinor: number;
  currency: string;
  placedAt: string;
  deadlineAt: string;
  holdUntil: string;
  settings: CheckoutSagaSettings;
}

export interface CheckoutSagaView {
  step: CheckoutStep;
  orderStatus: OrderStatus | null;
  tryOutcome: ReserveOutcome | null;
  pendingCompensations: CompensationCommand[];
  deadlineAt: string;
}

export const reserveUpdate = defineUpdate<ReserveOutcome>('reserve');
export const cancelUpdate = defineUpdate<'CANCELLED', [{ by: CancelBy }]>('cancel');
export const paymentAuthorizedSignal = defineSignal<[PaymentAuthorization]>('paymentAuthorized');
export const stateQuery = defineQuery<CheckoutSagaView>('state');

export interface CompensationInput {
  orderId: string;
  reason: CompensationReason;
}

/**
 * What the worker registers. Business outcomes are returned; a transient fault is thrown and
 * retried, and so is an outcome the saga cannot act on (a capture or compensation CONFLICT).
 */
export interface CheckoutSagaActivityFunctions {
  tryReserve(input: { orderId: string; lines: CheckoutSagaLine[]; holdUntil: string }): Promise<ParticipantTryOutcome>;
  applyTryResult(input: ApplyTryResultInput): Promise<SagaWriteResult>;
  applyOrderChange(input: ApplyOrderChangeInput): Promise<SagaWriteResult>;
  verifyAuthorization(input: { orderId: string; paymentId: string }): Promise<AuthorizationVerdict>;
  commitStock(input: { orderId: string }): Promise<CommitOutcome>;
  capturePayment(input: { orderId: string }): Promise<SettledCaptureOutcome>;
  releaseStock(input: CompensationInput): Promise<void>;
  restock(input: CompensationInput): Promise<void>;
  cancelPayment(input: CompensationInput): Promise<void>;
  /** The order's status now, null when there is no such order. */
  loadLateAuthorizationContext(input: { orderId: string }): Promise<OrderStatus | null>;
}
