// Application-facing metrics seam. Pure (no prom-client/framework import) so application code
// can depend on it without pulling infrastructure; the implementation is business.metrics.ts. ADR-0014.

export const METRICS = Symbol('METRICS');

/** Cart write operations, mirroring CartService's methods (low-cardinality label). */
export type CartOperation = 'add' | 'update' | 'remove' | 'clear';

/**
 * What one cache lookup did. `hit`/`miss`/`error` are the fixed-TTL path's three outcomes, where
 * `error` is Redis being unreachable — a served-from-source read that is not a cold miss, and the
 * signal that the cache is down.
 *
 * The rest belong to the stampede-protected path. It reports exactly one outcome per lookup —
 * hit_fresh, hit_stale, miss or error_fallthrough — and, alongside it, the work that lookup did:
 * the lock it took (lock_acquired), the wait it served out (lock_wait, then lock_timeout if the
 * holder never delivered), and the rebuild it ran.
 */
export type CacheResult =
  | 'miss'
  | 'error'
  | 'hit_fresh'
  | 'hit_stale'
  | 'rebuild'
  | 'lock_acquired'
  | 'lock_wait'
  | 'lock_timeout'
  | 'error_fallthrough'
  | 'store_rejected';

/** Circuit-breaker positions. `half_open` is the single trial call that decides whether the downstream has recovered. */
export type BreakerState = 'closed' | 'half_open' | 'open';

/** How one call through a breaker ended. `rejected` never reached the downstream (breaker open); `fallback` is the degraded answer served in its place. */
export type BreakerCallResult = 'success' | 'failure' | 'timeout' | 'rejected' | 'fallback';

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

/** WHICH PATH noticed money on an order that will never ship — the observer, not the cause. */
export type RefundOwedSource = 'expire_session' | 'webhook_direct' | 'settlement_event';

/** The transactional messages this system sends. */
export type MailKind = 'email_verification' | 'password_reset' | 'order_paid';

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
  /** One Catalog cache lookup made progress — an outcome, or a step of the stampede-protected path. */
  recordCatalogCacheOperation(result: CacheResult): void;
  /** One cache entry was rebuilt from its source, in seconds. Measured under the single-flight lock, so it is also the number the lock lease must stay ahead of. */
  observeCacheRebuild(seconds: number): void;
  /** A breaker settled into a state. `breaker` names the wrapped dependency and must be a fixed set of names, never a per-call value. */
  setBreakerState(breaker: string, state: BreakerState): void;
  /** A breaker changed state. Same cardinality rule on `breaker` as above. */
  recordBreakerTransition(breaker: string, to: BreakerState): void;
  /** One call through a breaker finished. Same cardinality rule on `breaker` as above. */
  recordBreakerCall(breaker: string, result: BreakerCallResult): void;
  /** A request was rejected by the rate limiter. `tier` is a configured throttler tier and `route` a route template — both bounded. */
  recordRateLimitRejection(tier: string, route: string): void;
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
  /** A path noticed money on an order that cannot be fulfilled. Observations, not refunds: one order can raise several. */
  recordRefundOwed(source: RefundOwedSource): void;
  /** The reservation sweep expired one order whose hold had lapsed. */
  recordReservationExpiry(): void;
  /** A message could not be sent. Nothing retries it, so this counts mail actually lost, not mail delayed. */
  recordMailSendFailure(kind: MailKind): void;
  /** One retention sweep finished and reclaimed `rows`. `sweep` is a fixed `context:table` name, never a per-row value. */
  recordRetentionSweep(sweep: string, rows: number): void;
  /** How long one retention sweep took, in seconds. Same cardinality rule on `sweep` as above. */
  observeRetentionSweepDuration(sweep: string, seconds: number): void;
  /** One retention sweep threw or timed out. Counted separately because a sweep that reclaims nothing and one that cannot run are indistinguishable from the rows counter alone. */
  recordRetentionSweepFailure(sweep: string): void;
}
