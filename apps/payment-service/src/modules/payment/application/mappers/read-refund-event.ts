export const REFUND_EVENT_TYPES: ReadonlySet<string> = new Set(['refund.created', 'refund.updated', 'refund.failed']);

/**
 * Only the refund's id is taken from the body: its state is read back from Stripe, because
 * `refund.updated` deliveries arrive out of order and a stale one would undo a newer state.
 */
export function readRefundEvent(payload: unknown): { refundId?: string } {
  const refund = asRecord(asRecord(asRecord(payload)?.data)?.object);
  const id = refund?.id;
  return typeof id === 'string' && id.startsWith('re_') ? { refundId: id } : {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}
