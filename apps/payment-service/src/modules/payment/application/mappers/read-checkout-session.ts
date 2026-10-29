/**
 * The event body is authenticated but its inner shape is the sender's, so every field is optional and
 * a missing or wrongly-typed one yields undefined rather than throwing — each caller decides what
 * absence means.
 */
export interface CheckoutSessionFacts {
  sessionId?: string;
  intentId?: string;
  /** Whether the money actually cleared: `paid` | `unpaid` | `no_payment_required`. */
  paymentStatus?: string;
  amountMinor?: number;
  /** ISO-4217, lowercase as Stripe sends it. */
  currency?: string;
}

export function readCheckoutSession(payload: unknown): CheckoutSessionFacts {
  const session = asRecord(asRecord(asRecord(payload)?.data)?.object);
  return {
    sessionId: asString(session?.id),
    intentId: asString(session?.payment_intent),
    paymentStatus: asString(session?.payment_status),
    amountMinor: asInteger(session?.amount_total),
    currency: asString(session?.currency),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}
