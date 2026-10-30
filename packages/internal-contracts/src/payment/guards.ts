import { isNonEmptyString, isOneOf, isRecord } from '../common/body-guards';
import {
  CANCEL_OUTCOME_STATUS,
  CAPTURE_OUTCOME_STATUS,
  PROVIDER_UNAVAILABLE_STATUS,
  SESSION_OUTCOME_STATUS,
} from './routes';
import {
  CANCEL_OUTCOMES,
  CAPTURE_OUTCOMES,
  type CancelOutcome,
  type CancelResponse,
  type CaptureOutcome,
  type CaptureResponse,
  type OpenSessionResponse,
  PAYMENT_ORDER_STATUSES,
  PROVIDER_UNAVAILABLE,
  type PaymentStatusEntry,
  type PaymentStatusResponse,
} from './types';

const isCaptureOutcome = isOneOf(CAPTURE_OUTCOMES);
const isCancelOutcome = isOneOf(CANCEL_OUTCOMES);
const isPaymentOrderStatus = isOneOf(PAYMENT_ORDER_STATUSES);

const isOptionalString = (value: unknown) => value === undefined || typeof value === 'string';

export function isOpenSessionResponse(body: unknown): body is OpenSessionResponse {
  if (!isRecord(body)) return false;
  if (body.outcome === 'CLOSED') return true;
  return (
    body.outcome === 'OPENED' &&
    isNonEmptyString(body.paymentId) &&
    isNonEmptyString(body.providerSessionId) &&
    isOptionalString(body.redirectUrl) &&
    isOptionalString(body.clientSecret)
  );
}

export function isCaptureResponse(body: unknown): body is CaptureResponse {
  return isRecord(body) && isCaptureOutcome(body.outcome);
}

export function isCancelResponse(body: unknown): body is CancelResponse {
  return isRecord(body) && isCancelOutcome(body.outcome);
}

function isPaymentStatusEntry(entry: unknown): entry is PaymentStatusEntry {
  return (
    isRecord(entry) &&
    (entry.header === null || isPaymentOrderStatus(entry.header)) &&
    (entry.authorizedPaymentId === null || isNonEmptyString(entry.authorizedPaymentId)) &&
    typeof entry.hasAuthorizedAttempt === 'boolean' &&
    typeof entry.hasSucceededAttempt === 'boolean'
  );
}

export function isPaymentStatusResponse(body: unknown): body is PaymentStatusResponse {
  return isRecord(body) && isRecord(body.statuses) && Object.values(body.statuses).every(isPaymentStatusEntry);
}

/** The answer, cut down to the contract's fields, or undefined when the status code disagrees with it. */
export function sessionOutcomeOf(status: number, body: unknown): OpenSessionResponse | undefined {
  if (!isOpenSessionResponse(body) || SESSION_OUTCOME_STATUS[body.outcome] !== status) return undefined;
  if (body.outcome === 'CLOSED') return { outcome: 'CLOSED' };
  const { paymentId, providerSessionId, redirectUrl, clientSecret } = body;
  return {
    outcome: 'OPENED',
    paymentId,
    providerSessionId,
    ...(redirectUrl === undefined ? {} : { redirectUrl }),
    ...(clientSecret === undefined ? {} : { clientSecret }),
  };
}

export function captureOutcomeOf(status: number, body: unknown): CaptureOutcome | undefined {
  return isCaptureResponse(body) && CAPTURE_OUTCOME_STATUS[body.outcome] === status ? body.outcome : undefined;
}

export function cancelOutcomeOf(status: number, body: unknown): CancelOutcome | undefined {
  return isCancelResponse(body) && CANCEL_OUTCOME_STATUS[body.outcome] === status ? body.outcome : undefined;
}

export function isProviderUnavailable(status: number, body: unknown): boolean {
  return status === PROVIDER_UNAVAILABLE_STATUS && isRecord(body) && body.code === PROVIDER_UNAVAILABLE;
}

/** The statuses, or undefined when the body is malformed or leaves out an id that was asked for. */
export function paymentStatusesOf(
  body: unknown,
  orderIds: readonly string[],
): Map<string, PaymentStatusEntry> | undefined {
  if (!isPaymentStatusResponse(body)) return undefined;
  const { statuses } = body;
  if (!orderIds.every((orderId) => Object.hasOwn(statuses, orderId))) return undefined;
  return new Map(
    orderIds.map((orderId) => {
      const { header, authorizedPaymentId, hasAuthorizedAttempt, hasSucceededAttempt } = statuses[orderId];
      return [orderId, { header, authorizedPaymentId, hasAuthorizedAttempt, hasSucceededAttempt }];
    }),
  );
}
