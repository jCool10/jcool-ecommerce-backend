import type { PaymentStatus } from '../../domain/payment-status';

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
  // The reason separates the harmless (a late notice, a session already at rest on the outcome this
  // event reports, one still clearing) from the two that need a human: an outcome landing on a payment
  // already closed on a DIFFERENT one, and a charge that isn't ours.
  | {
      outcome: 'skipped';
      reason: 'payment_not_found' | 'conflict' | 'awaiting_payment' | 'amount_mismatch' | 'already_settled';
      providerEventId: string;
      eventType: string;
      conflict?: { orderId: string; from: PaymentStatus; to: PaymentStatus };
      charge?: {
        orderId: string;
        expectedMinor: number;
        expectedCurrency: string;
        actualMinor?: number;
        actualCurrency?: string;
      };
    }
  | { outcome: 'processed'; status: PaymentStatus; orderId: string; paymentRef: string | null; eventType: string };
