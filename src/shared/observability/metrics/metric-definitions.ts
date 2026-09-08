import type { Provider } from '@nestjs/common';
import { makeCounterProvider, makeGaugeProvider, makeHistogramProvider } from '@willsoto/nestjs-prometheus';
import { IDENTITY_CLOCK_PROVIDERS } from './identity-clock.collector';
import { OUTBOX_BACKLOG_PROVIDERS } from './outbox-backlog.collector';

// Prometheus conventions to hold to: `_total` suffix for counters, base-unit suffix (`_seconds`)
// for histograms, and no id/email/sku in any labelName (the cardinality iron rule).

export const HTTP_REQUEST_DURATION_SECONDS = 'http_request_duration_seconds';
export const HTTP_REQUESTS_TOTAL = 'http_requests_total';

export const ORDERS_CREATED_TOTAL = 'orders_created_total';
export const ORDER_VALUE_MINOR = 'order_value_minor';
export const CART_OPERATIONS_TOTAL = 'cart_operations_total';
export const CATALOG_CACHE_OPERATIONS_TOTAL = 'catalog_cache_operations_total';
export const AUTH_EVENTS_TOTAL = 'auth_events_total';

export const CACHE_REBUILD_DURATION_SECONDS = 'cache_rebuild_duration_seconds';
// A gauge, not a counter: "open right now" is what pages someone; how often it got there is the
// transitions counter below.
export const CIRCUIT_BREAKER_STATE = 'circuit_breaker_state';
export const CIRCUIT_BREAKER_TRANSITIONS_TOTAL = 'circuit_breaker_transitions_total';
export const CIRCUIT_BREAKER_CALLS_TOTAL = 'circuit_breaker_calls_total';
export const RATE_LIMIT_REJECTIONS_TOTAL = 'rate_limit_rejections_total';

export const MESSAGING_PUBLISH_TOTAL = 'messaging_publish_total';
export const MESSAGING_CONSUME_TOTAL = 'messaging_consume_total';
export const MESSAGING_CONSUME_RETRIES_TOTAL = 'messaging_consume_retries_total';
export const MESSAGING_DLQ_TOTAL = 'messaging_dlq_total';

// The steps are NOT nested — an order expired straight from its hold reaches finalize without ever
// reaching payment_session — so read them as rates side by side; a subtraction can go negative.
export const SAGA_STEP_TOTAL = 'saga_step_total';
export const SAGA_COMPENSATION_TOTAL = 'saga_compensation_total';
// Narrower than saga_compensation_total{trigger=ttl_expired}: only the orders the reservation sweep
// itself claimed. The difference is what the gateway-driven reconcile expired first, so once
// expiries are happening at all, the two rates converging means reconcile has stopped.
export const RESERVATION_EXPIRY_TOTAL = 'reservation_expiry_total';
export const PAYMENT_REFUND_OWED_TOTAL = 'payment_refund_owed_total';

export const MAIL_SEND_FAILURES_TOTAL = 'mail_send_failures_total';

export const RETENTION_ROWS_DELETED_TOTAL = 'retention_rows_deleted_total';
export const RETENTION_SWEEP_DURATION_SECONDS = 'retention_sweep_duration_seconds';
export const RETENTION_SWEEP_FAILURES_TOTAL = 'retention_sweep_failures_total';

export const MEDIA_BYTES_RECLAIMED_TOTAL = 'media_bytes_reclaimed_total';

// Latency buckets (seconds). Tuned to a k6 baseline (2026-08-15, ~21 req/s): global p99 ≈ 22ms;
// the argon2 auth routes are the tail (register ≈ 98ms, from a small sample). Dense resolution
// across 1–150ms, where every route's p95/p99 sits; the 0.25s boundary is the latency-SLO
// threshold; 2.5s is only an outlier catch (the old 5s bucket never saw traffic).
export const HTTP_LATENCY_BUCKETS = [
  0.001, 0.0025, 0.005, 0.01, 0.02, 0.035, 0.05, 0.075, 0.1, 0.15, 0.25, 0.5, 1, 2.5,
];
// Order-value buckets in minor units (VND has no minor unit → dong). Tuned to the baseline: mean
// order ≈ 21M and ~95% of orders land between 10M and 50M, so resolution is concentrated there
// (the old 10M ceiling was blind above it — most orders overflowed into +Inf).
export const ORDER_VALUE_BUCKETS = [
  100_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000, 15_000_000, 20_000_000, 30_000_000, 50_000_000,
  100_000_000,
];
// Rebuild buckets (seconds). A rebuild is one catalog query, so resolution sits where those land
// (single-digit ms to ~100ms); the 5s tail exists to make a rebuild that outlives the default lock
// lease visible rather than lumped into +Inf.
export const CACHE_REBUILD_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
// Retention sweep buckets (seconds). A sweep is one bounded DELETE, so the healthy range is
// milliseconds; the long tail exists because the interesting reading is a sweep approaching
// RETENTION_SWEEP_TIMEOUT_MS (default 30s), which is the point it starts skipping its own ticks.
export const RETENTION_SWEEP_BUCKETS = [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30];

/**
 * Eager DI providers, so every metric appears in `/metrics` (HELP/TYPE) before its first
 * observation rather than popping into existence when something happens to touch it.
 */
export const METRIC_PROVIDERS: Provider[] = [
  makeHistogramProvider({
    name: HTTP_REQUEST_DURATION_SECONDS,
    help: 'HTTP request duration in seconds (RED). Labels: method, route (template), status_code.',
    labelNames: ['method', 'route', 'status_code'],
    buckets: HTTP_LATENCY_BUCKETS,
  }),
  makeCounterProvider({
    name: HTTP_REQUESTS_TOTAL,
    help: 'Total HTTP requests (RED). Labels: method, route (template), status_code.',
    labelNames: ['method', 'route', 'status_code'],
  }),
  makeCounterProvider({
    name: ORDERS_CREATED_TOTAL,
    help: 'Orders placed (DRAFT → PENDING), by resulting status.',
    labelNames: ['status'],
  }),
  makeHistogramProvider({
    name: ORDER_VALUE_MINOR,
    help: 'Placed-order value distribution in minor currency units.',
    buckets: ORDER_VALUE_BUCKETS,
  }),
  makeCounterProvider({
    name: CART_OPERATIONS_TOTAL,
    help: 'Cart write operations, by op (add/update/remove/clear).',
    labelNames: ['op'],
  }),
  makeCounterProvider({
    name: CATALOG_CACHE_OPERATIONS_TOTAL,
    help: 'Catalog cache lookups. Exactly one outcome per lookup: hit_fresh/hit_stale/miss when the cache answered or refilled, error/error_fallthrough when Redis was unreachable and Postgres answered instead. The same metric also counts the work a lookup did — lock_acquired, rebuild, lock_wait, lock_timeout (waited for another rebuilder and got nothing), store_rejected — so a hit ratio must name the outcome values on both sides of the division instead of dividing by the total.',
    labelNames: ['result'],
  }),
  makeCounterProvider({
    name: AUTH_EVENTS_TOTAL,
    help: 'Auth audit events, by event and outcome.',
    labelNames: ['event', 'outcome'],
  }),
  makeCounterProvider({
    name: MESSAGING_PUBLISH_TOTAL,
    help: 'Publish attempts by the relay, by event_type and result (published = accepted by the queue, refused = kept for a later tick). Attempts, not rows: a tick that rolls back after publishing has already counted, and the row is counted again when the next tick resends it.',
    labelNames: ['event_type', 'result'],
  }),
  makeCounterProvider({
    name: MESSAGING_CONSUME_TOTAL,
    help: 'Domain events consumed, by event_type and result (processed = effect applied, duplicate = collapsed by the inbox, failed = effect rolled back).',
    labelNames: ['event_type', 'result'],
  }),
  makeCounterProvider({
    name: MESSAGING_CONSUME_RETRIES_TOTAL,
    help: 'Failed deliveries the queue will retry after a backoff, by event_type.',
    labelNames: ['event_type'],
  }),
  makeCounterProvider({
    name: MESSAGING_DLQ_TOTAL,
    help: 'Messages moved to the dead-letter queue, by event_type and reason (permanent = retrying could never fix it, attempts_exhausted = it stayed broken for the whole budget).',
    labelNames: ['event_type', 'reason'],
  }),
  makeCounterProvider({
    name: SAGA_STEP_TOTAL,
    help: 'Checkout saga steps, by step (reserve/payment_session/finalize) and outcome. A settlement that moved nothing — a duplicate, or one conflicting with an order already terminal — is not counted: it repeats a step rather than adding one. Only the repeats arriving over the queue also show up in messaging_consume_total; one from the payment webhook or the reconcile sweep is in neither, and the "conflicting finalize ignored" log is the only place it appears.',
    labelNames: ['step', 'outcome'],
  }),
  makeCounterProvider({
    name: SAGA_COMPENSATION_TOTAL,
    help: 'Orders that released their stock hold instead of committing it, by trigger (payment_failed/ttl_expired/cancelled).',
    labelNames: ['trigger'],
  }),
  makeCounterProvider({
    name: RESERVATION_EXPIRY_TOTAL,
    help: 'Orders the reservation sweep expired because their hold had lapsed. Orders, not reservation rows: a multi-line order is one hold to the sweep.',
  }),
  makeCounterProvider({
    name: PAYMENT_REFUND_OWED_TOTAL,
    help: 'Times a path found money on an order that will never be fulfilled, labelled by which path saw it: expire_session = closing the checkout session found the money instead; webhook_direct and settlement_event = a successful payment landing on an order already cancelled or expired, seen by the in-process finalize and by its durable event. Observations, not refunds — one stranded payment normally raises two of these, so alert on the sum being non-zero and get the count from the database, never by summing this.',
    labelNames: ['source'],
  }),
  makeCounterProvider({
    name: MAIL_SEND_FAILURES_TOTAL,
    help: 'Messages the transport refused or could not deliver, by kind. Nothing retries them: the auth kinds are re-triggerable by the user (resend verification, ask for another reset link), order_paid is a confirmation simply lost.',
    labelNames: ['kind'],
  }),
  makeCounterProvider({
    name: RETENTION_ROWS_DELETED_TOTAL,
    help: 'Rows reclaimed by the retention sweeps, by sweep (context:table). A label that stays flat is either a table with nothing to collect or a sweep that is not running — retention_sweep_failures_total is what tells the two apart.',
    labelNames: ['sweep'],
  }),
  makeHistogramProvider({
    name: RETENTION_SWEEP_DURATION_SECONDS,
    help: 'Time one retention sweep took, by sweep. Read comparatively: the sweep well above the others is the one that will start exceeding its timeout and skipping its own ticks.',
    labelNames: ['sweep'],
    buckets: RETENTION_SWEEP_BUCKETS,
  }),
  makeCounterProvider({
    name: RETENTION_SWEEP_FAILURES_TOTAL,
    help: 'Retention sweeps that threw or exceeded their timeout, by sweep. Failures are isolated per sweep, so this rising on one label says nothing about the others.',
    labelNames: ['sweep'],
  }),
  makeCounterProvider({
    name: MEDIA_BYTES_RECLAIMED_TOTAL,
    help: 'Bytes the media sweep deleted from the bucket. Pairs with retention_rows_deleted_total{sweep="media:assets"}: rows say how many uploads were abandoned, this says what they cost.',
  }),
  makeHistogramProvider({
    name: CACHE_REBUILD_DURATION_SECONDS,
    help: 'Time to rebuild one cache entry from its source, measured while the single-flight lock is held.',
    buckets: CACHE_REBUILD_BUCKETS,
  }),
  makeGaugeProvider({
    name: CIRCUIT_BREAKER_STATE,
    help: 'Current circuit-breaker state per breaker: 0 = closed, 1 = half_open, 2 = open.',
    labelNames: ['breaker'],
  }),
  makeCounterProvider({
    name: CIRCUIT_BREAKER_TRANSITIONS_TOTAL,
    help: 'Circuit-breaker state changes, by breaker and the state entered (to).',
    labelNames: ['breaker', 'to'],
  }),
  makeCounterProvider({
    name: CIRCUIT_BREAKER_CALLS_TOTAL,
    help: 'Calls through a circuit breaker, by breaker and result (success/failure/timeout/rejected = refused while open/fallback = the degraded answer served instead).',
    labelNames: ['breaker', 'result'],
  }),
  makeCounterProvider({
    name: RATE_LIMIT_REJECTIONS_TOTAL,
    help: 'Requests rejected with 429, by throttler tier and route (template, never a concrete path).',
    labelNames: ['tier', 'route'],
  }),
  ...OUTBOX_BACKLOG_PROVIDERS,
  ...IDENTITY_CLOCK_PROVIDERS,
];
