// Nothing here may import prom-client or a framework: application code depends on this seam and
// must not pull infrastructure with it.

export const METRICS = Symbol('METRICS');

export type CartOperation = 'add' | 'update' | 'remove' | 'clear';

/**
 * `error` is Redis unreachable — a served-from-source read, NOT a cold miss, and the signal that
 * the cache is down. The stampede-protected path reports exactly one outcome per lookup
 * (hit_fresh/hit_stale/miss/error_fallthrough) plus the work it did (lock_*, rebuild).
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

/** `half_open` is the single trial call that decides whether the downstream has recovered. */
export type BreakerState = 'closed' | 'half_open' | 'open';

/** `rejected` never reached the downstream; `fallback` is the degraded answer served in its place. */
export type BreakerCallResult = 'success' | 'failure' | 'timeout' | 'rejected' | 'fallback';

/** `refused` leaves the row unpublished for a later tick, so it counts a delay, not a loss. */
export type PublishResult = 'published' | 'refused';

/** `duplicate` is a redelivery the inbox collapsed — routine, not a failure. `failed` rolled back. */
export type ConsumeResult = 'processed' | 'duplicate' | 'failed';

export type DeadLetterReason = 'permanent' | 'attempts_exhausted';

/** In the order the saga runs them; `compensate` counts each compensation tried. */
export type SagaStep = 'try_reserve' | 'open_session' | 'commit_stock' | 'capture' | 'compensate';

export type CompensationTrigger =
  | 'try_failed'
  | 'expired'
  | 'cancelled'
  | 'commit_conflict'
  | 'capture_failed'
  | 'late_authorization'
  | 'amount_mismatch';

export type TccParticipant = 'inventory' | 'payment';

export type TccOp = 'try' | 'commit' | 'release' | 'restock' | 'open_session' | 'capture' | 'cancel' | 'sweep';

/** `fenced`: release before any Try; `rejected`: business refusal; `error`: outcome unknown. */
export type TccBranchOutcome = 'ok' | 'idempotent' | 'conflict' | 'fenced' | 'rejected' | 'error';

/** WHICH PATH noticed money on an order that will never ship — the observer, not the cause. */
export type RefundOwedSource = 'webhook_direct';

export type MailKind = 'email_verification' | 'password_reset' | 'order_paid';

/** `miss` is a read-through to the user-service, paid for on the request path. */
export type SessionEpochLookupResult = 'hit' | 'miss';

/**
 * Every `string` parameter below is a Prometheus LABEL: callers pass only bounded values, never an
 * id/email/sku/concrete path (those belong on logs and spans).
 */
export interface MetricsPort {
  /** Recorded on DRAFT → PENDING, not on draft creation. */
  recordOrderCreated(status: string): void;
  observeOrderValue(amountMinor: number): void;
  /** Successful mutations only. */
  recordCartOperation(op: CartOperation): void;
  /** `event` is the bounded AuthAuditEvent union. */
  recordAuthEvent(event: string, outcome: 'success' | 'failure'): void;
  recordCatalogCacheOperation(result: CacheResult): void;
  /** Measured under the single-flight lock, so it is the number the lock lease must stay ahead of. */
  observeCacheRebuild(seconds: number): void;
  /** `breaker` is a fixed dependency name, never a per-call value. Same for the two below. */
  setBreakerState(breaker: string, state: BreakerState): void;
  recordBreakerTransition(breaker: string, to: BreakerState): void;
  recordBreakerCall(breaker: string, result: BreakerCallResult): void;
  /** `route` is a route TEMPLATE; the concrete path would be unbounded. */
  recordRateLimitRejection(tier: string, route: string): void;
  recordEventPublished(eventType: string, result: PublishResult): void;
  /** `eventType` must be a registered event name, never a value straight off the wire. Same below. */
  recordEventConsumed(eventType: string, result: ConsumeResult): void;
  recordConsumeRetry(eventType: string): void;
  recordDeadLetter(eventType: string, reason: DeadLetterReason): void;
  /** `failed` covers both a refusal and a call with no answer; a compensation is counted per try. */
  recordSagaStep(step: SagaStep, outcome: 'success' | 'failed'): void;
  recordCompensation(trigger: CompensationTrigger): void;
  recordTccBranch(participant: TccParticipant, op: TccOp, outcome: TccBranchOutcome): void;
  /** Observations, not refunds — one order can raise several. */
  recordRefundOwed(source: RefundOwedSource): void;
  /** A cancel that found the order's money already captured: someone must refund by hand. */
  recordCaptureConflict(): void;
  /** Nothing retries a failed send, so this counts mail actually lost, not mail delayed. */
  recordMailSendFailure(kind: MailKind): void;
  /** `sweep` is a fixed `context:table` name. Same for the two below. */
  recordRetentionSweep(sweep: string, rows: number): void;
  observeRetentionSweepDuration(sweep: string, seconds: number): void;
  /** Separate from the rows counter: reclaiming nothing and failing to run look alike there. */
  recordRetentionSweepFailure(sweep: string): void;
  recordMediaBytesReclaimed(bytes: number): void;
  recordSessionEpochLookup(result: SessionEpochLookupResult): void;
}
