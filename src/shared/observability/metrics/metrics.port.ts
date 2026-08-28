// Application-facing metrics seam. Pure (no prom-client/framework import) so application code
// can depend on it without pulling infrastructure; the implementation is business.metrics.ts. ADR-0014.

export const METRICS = Symbol('METRICS');

/** Cart write operations, mirroring CartService's methods (low-cardinality label). */
export type CartOperation = 'add' | 'update' | 'remove' | 'clear';

/** Outcome of one cache lookup. `error` is Redis being unreachable — a served-from-source read that is not a cold miss, and the signal that the cache is down. */
export type CacheResult = 'hit' | 'miss' | 'error';

/** Outcome of handing one outbox row to the queue. `refused` is the queue rejecting it — the row stays unpublished and a later tick tries again, so this counts a delay, not a loss. */
export type PublishResult = 'published' | 'refused';

/** Result of applying one delivered domain event. `duplicate` is a redelivery the inbox collapsed — routine under at-least-once delivery, not a failure. `failed` means the effect rolled back. */
export type ConsumeResult = 'processed' | 'duplicate' | 'failed';

/** Why a message stopped being retried. `permanent` is a failure retrying could never fix (bad envelope, no handler); `attempts_exhausted` is one that stayed broken for the whole retry budget. */
export type DeadLetterReason = 'permanent' | 'attempts_exhausted';

/** A step of the checkout saga, in the order it runs: hold the stock, open the charge, settle the order. */
export type SagaStep = 'reserve' | 'payment_session' | 'finalize';

/** Why an order handed its stock back instead of committing it. */
export type CompensationTrigger = 'payment_failed' | 'ttl_expired' | 'cancelled';

/**
 * Business events worth counting. Callers pass only bounded, low-cardinality values —
 * never an id/email/sku (those belong on logs/spans, not Prometheus labels).
 */
export interface MetricsPort {
  /** An order moved DRAFT → PENDING. `status` is the resulting order status (enum, bounded). */
  recordOrderCreated(status: string): void;
  /** Placed-order value in minor currency units (for the value distribution histogram). */
  observeOrderValue(amountMinor: number): void;
  /** A cart mutation succeeded. */
  recordCartOperation(op: CartOperation): void;
  /** A security-relevant auth event fired (`event` is the bounded AuthAuditEvent union). */
  recordAuthEvent(event: string, outcome: 'success' | 'failure'): void;
  /** One Catalog cache-aside lookup resolved. */
  recordCatalogCacheOperation(result: CacheResult): void;
  /** The relay finished one publish attempt. Same cardinality rule as the consume side: a registered event name only. */
  recordEventPublished(eventType: string, result: PublishResult): void;
  /** One domain event finished consuming. `eventType` must be a registered event name — never a value straight off the wire, which would be unbounded label cardinality. */
  recordEventConsumed(eventType: string, result: ConsumeResult): void;
  /** A failed delivery the transport will try again. Same cardinality rule as above. */
  recordConsumeRetry(eventType: string): void;
  /** A message moved to the dead-letter queue — it will not be tried again without a human. Same cardinality rule as above. */
  recordDeadLetter(eventType: string, reason: DeadLetterReason): void;
  /** One checkout-saga step resolved. Read as a funnel — orders that hold stock but never reach `finalize` are the ones the sweep will expire. */
  recordSagaStep(step: SagaStep, outcome: 'success' | 'failed'): void;
  /** An order released its stock hold instead of committing it — the saga's rollback, counted by what triggered it. */
  recordCompensation(trigger: CompensationTrigger): void;
  /** The reservation sweep expired one order whose hold had lapsed. */
  recordReservationExpiry(): void;
}
