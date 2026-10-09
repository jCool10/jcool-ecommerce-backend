import type { PaymentStatus } from '../../domain/payment-status';

export type WebhookSkipReason =
  'payment_not_found' | 'conflict' | 'awaiting_payment' | 'amount_mismatch' | 'already_settled';

/**
 * `rejected` (verify failed) and `unavailable` (the gateway could not be read) are the only non-2xx
 * results, and neither persists anything; every other outcome means the event was accepted and logged,
 * so the gateway gets a 2xx and stops retrying.
 */
export type WebhookProcessResult =
  | { outcome: 'rejected'; reason: 'invalid_signature' | 'expired_timestamp' }
  | { outcome: 'unavailable'; providerEventId: string; eventType: string }
  | { outcome: 'duplicate'; providerEventId: string; eventType: string }
  | { outcome: 'ignored'; providerEventId: string; eventType: string }
  | { outcome: 'skipped'; reason: WebhookSkipReason; providerEventId: string; eventType: string }
  // A session opened before the checkout saga took over: no order settles against it any more, so
  // money it captured is owed back.
  | {
      outcome: 'skipped';
      reason: 'unfenced';
      providerEventId: string;
      eventType: string;
      orderId: string;
      captured: boolean;
    }
  | { outcome: 'processed'; status: PaymentStatus; orderId: string; paymentRef: string | null; eventType: string };
