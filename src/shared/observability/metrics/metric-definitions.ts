import type { Provider } from '@nestjs/common';
import { makeCounterProvider, makeGaugeProvider, makeHistogramProvider } from '@willsoto/nestjs-prometheus';
import { OUTBOX_BACKLOG_PROVIDERS } from './outbox-backlog.collector';

// Metric names in one place so the providers, the @InjectMetric() consumers, and the tests
// never drift. Prometheus conventions: `_total` suffix for counters, base-unit suffix
// (`_seconds`) for histograms, no id/email/sku in any labelName (cardinality iron rule).

// --- RED (http) ---
export const HTTP_REQUEST_DURATION_SECONDS = 'http_request_duration_seconds';
export const HTTP_REQUESTS_TOTAL = 'http_requests_total';

// --- Business ---
export const ORDERS_CREATED_TOTAL = 'orders_created_total';
export const ORDER_VALUE_MINOR = 'order_value_minor';
export const CART_OPERATIONS_TOTAL = 'cart_operations_total';
export const CATALOG_CACHE_OPERATIONS_TOTAL = 'catalog_cache_operations_total';
export const AUTH_EVENTS_TOTAL = 'auth_events_total';

// --- Resilience ---
// How long the source takes to answer while a rebuild lock is held. It is the number the lock lease
// has to stay ahead of: once the p99 here approaches the lease, holders start losing the lock
// mid-rebuild and the herd comes back.
export const CACHE_REBUILD_DURATION_SECONDS = 'cache_rebuild_duration_seconds';
// The breaker's current position, per breaker. A gauge rather than a counter because "open right
// now" is what pages someone; how often it got there is the transitions counter below.
export const CIRCUIT_BREAKER_STATE = 'circuit_breaker_state';
export const CIRCUIT_BREAKER_TRANSITIONS_TOTAL = 'circuit_breaker_transitions_total';
// The two halves of a breaker's story: `failure`/`timeout` are calls the downstream actually cost
// us, `rejected` are the ones it never saw because the breaker was open — a rising rejected rate
// with no failures is the breaker doing its job, not a new outage.
export const CIRCUIT_BREAKER_CALLS_TOTAL = 'circuit_breaker_calls_total';
// Requests refused by the rate limiter. Read per tier: a spike on the pre-auth tiers is an attack
// or a NAT'd office, the same spike on the per-user tier is one account misbehaving.
export const RATE_LIMIT_REJECTIONS_TOTAL = 'rate_limit_rejections_total';

// --- Messaging ---
// Publishes are the producer half of the pipeline, and the only place a queue outage is visible as
// a number: the relay keeps refused rows for the next tick, so nothing is lost, but a sustained
// `refused` rate means events are piling up in Postgres. Read it against the backlog gauges — this
// counter says the relay is trying, they say how far behind it has fallen.
export const MESSAGING_PUBLISH_TOTAL = 'messaging_publish_total';
// The ratio between the results is the operational read on the pipeline: a steady trickle of
// duplicates is at-least-once working as designed, a spike means the relay or the queue is
// redelivering far more than it should, and any sustained `failed` rate means events are being
// published and never applied. Counting failures matters as much as successes — without them a
// pipeline where every consume throws is indistinguishable from an idle one.
export const MESSAGING_CONSUME_TOTAL = 'messaging_consume_total';
// Retries and dead letters are the same failure seen at two horizons. A rising retry rate with a
// flat DLQ is a dependency wobbling and the backoff absorbing it; a rising DLQ means messages are
// now being parked for a human, and is the one of the two worth waking someone for.
export const MESSAGING_CONSUME_RETRIES_TOTAL = 'messaging_consume_retries_total';
export const MESSAGING_DLQ_TOTAL = 'messaging_dlq_total';

// --- Saga ---
// The checkout saga's funnel. Each step commits its own transaction, so an order can stop between
// any two of them and sit there holding stock. Read the steps as rates side by side, not as a
// subtraction: an order that reserves, never opens a session and is expired straight from the hold
// reaches finalize without ever reaching payment_session, so the steps are not nested and a
// difference between them can go negative. What leaves the funnel shows up in the counters below.
export const SAGA_STEP_TOTAL = 'saga_step_total';
// Compensation is the saga's only rollback, so this is the rate at which checkouts are being undone.
// The trigger says whose fault it was — a payment_failed spike is the gateway, a ttl_expired spike is
// buyers abandoning or webhooks not arriving, and telling those apart is the whole point of the label.
export const SAGA_COMPENSATION_TOTAL = 'saga_compensation_total';
// Deliberately narrower than saga_compensation_total{trigger=ttl_expired}: that one counts every
// order that ended EXPIRED, this one only those the reservation sweep itself claimed. The difference
// is what the gateway-driven reconcile expired first, which is the ordering the sweep's boot guard
// exists to preserve — so once expiries are actually happening, the two rates converging means
// reconcile has stopped. Both sit at 0 on a healthy quiet shop, where the comparison says nothing.
export const RESERVATION_EXPIRY_TOTAL = 'reservation_expiry_total';

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

/**
 * Every metric registered as an eager DI provider, so all appear in `/metrics` (HELP/TYPE)
 * before the first observation. Outbox gauges live in outbox-backlog.collector.ts.
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
    help: 'Catalog cache lookups. Exactly one outcome per lookup: hit/miss/error on the fixed-TTL path, hit_fresh/hit_stale/miss/error_fallthrough on the stampede-protected one (error and error_fallthrough = Redis unreachable or refusing writes, served from Postgres). That path also counts the work a lookup did — lock_acquired, rebuild, lock_wait, lock_timeout — under the same metric, so a hit ratio must name the outcome values on both sides of the division instead of dividing by the total.',
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
];
