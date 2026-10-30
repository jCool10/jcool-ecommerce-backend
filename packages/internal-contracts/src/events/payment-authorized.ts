import { isRecord } from '../common/body-guards';

export const PAYMENT_AUTHORIZED_EVENT = 'payment.authorized';

/** A snapshot: the consumer signalling the saga never reads payment's tables. */
export interface PaymentAuthorizedPayload {
  paymentId: string;
  orderId: string;
  amountMinor: number;
  /** ISO-4217, upper case. */
  currency: string;
  /** ISO-8601 in UTC, the instant payment's header turned AUTHORIZED. */
  authorizedAt: string;
}

const ISO_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const CURRENCY = /^[A-Z]{3}$/;

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export function paymentAuthorizedPayload(
  facts: Omit<PaymentAuthorizedPayload, 'authorizedAt'> & { authorizedAt: Date },
): PaymentAuthorizedPayload {
  return {
    paymentId: facts.paymentId,
    orderId: facts.orderId,
    amountMinor: facts.amountMinor,
    currency: facts.currency,
    authorizedAt: facts.authorizedAt.toISOString(),
  };
}

/** Shape only; whether the ids are routable is the consumer's call. */
export function isPaymentAuthorizedPayload(payload: unknown): payload is PaymentAuthorizedPayload {
  if (!isRecord(payload)) return false;
  const { paymentId, orderId, amountMinor, currency, authorizedAt } = payload;
  return (
    isNonEmptyString(paymentId) &&
    isNonEmptyString(orderId) &&
    Number.isSafeInteger(amountMinor) &&
    (amountMinor as number) > 0 &&
    typeof currency === 'string' &&
    CURRENCY.test(currency) &&
    typeof authorizedAt === 'string' &&
    ISO_UTC_INSTANT.test(authorizedAt) &&
    !Number.isNaN(Date.parse(authorizedAt))
  );
}
