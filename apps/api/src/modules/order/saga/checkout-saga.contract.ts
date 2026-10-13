import { defineSearchAttributeKey, SearchAttributeType } from '@temporalio/common';
import { defineQuery, defineSignal, defineUpdate } from '@temporalio/workflow';
import type { TryVerdict } from '../domain/checkout-saga';
import type { CheckoutSagaStep, Compensation } from '../domain/checkout-saga-step';

// Shared by the workflow bundle and the client: nothing here may touch Node, Nest or the database.

export const CHECKOUT_SAGA_WORKFLOW = 'CheckoutSaga';
export const RESERVE_UPDATE_ID = 'reserve';
export const CHECKOUT_NOT_CANCELLABLE = 'CheckoutNotCancellable';

export const workflowIdFor = (orderId: string): string => `checkout-${orderId}`;

export const CHECKOUT_STEP_ATTRIBUTE = defineSearchAttributeKey('CheckoutStep', SearchAttributeType.KEYWORD);
export const CHECKOUT_DEADLINE_ATTRIBUTE = defineSearchAttributeKey('CheckoutDeadlineAt', SearchAttributeType.DATETIME);

/** Fixed at start, so a replay never sees a value changed by a later deploy. */
export interface CheckoutSagaTimings {
  tryTimeoutMs: number;
  authGraceMs: number;
  cancelWaitMs: number;
  activityTimeoutMs: number;
  retryBaseMs: number;
  retryCapMs: number;
}

/** Dates travel as ISO strings: the payload converter would hand a Date back as a string anyway. */
export interface CheckoutSagaStart {
  mode: 'checkout';
  orderId: string;
  lines: { skuId: string; quantity: number }[];
  totalMinor: number;
  currency: string;
  placedAt: string;
  deadlineAt: string;
  holdUntil: string;
  idempotency?: { scope: string; key: string };
  timings: CheckoutSagaTimings;
}

/** Opened by an authorization that found the checkout saga already closed. */
export interface LateAuthorizationStart {
  mode: 'lateAuthorization';
  orderId: string;
  timings: CheckoutSagaTimings;
}

export type CheckoutSagaInput = CheckoutSagaStart | LateAuthorizationStart;

export interface PaymentAuthorizedPayload {
  paymentId: string;
  amountMinor: number;
  currency: string;
  authorizedAt: string;
}

export interface CheckoutSagaState {
  step: CheckoutSagaStep;
  pendingCompensations: Compensation[];
  deadlineAt: string | null;
}

export interface CancelRequest {
  by: 'user' | 'admin';
}

export const reserveUpdate = defineUpdate<{ verdict: TryVerdict }>('reserve');
export const cancelUpdate = defineUpdate<{ settled: boolean }, [CancelRequest]>('cancel');
export const paymentAuthorizedSignal = defineSignal<[PaymentAuthorizedPayload]>('paymentAuthorized');
export const stateQuery = defineQuery<CheckoutSagaState>('state');
