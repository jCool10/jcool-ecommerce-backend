import type { Provider } from '@nestjs/common';
import { makeCounterProvider, makeHistogramProvider } from '@willsoto/nestjs-prometheus';
import { OUTBOX_SEAM_PROVIDERS } from './outbox-backlog.collector';

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

// --- Messaging ---
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
    help: 'Catalog cache-aside lookups, by result (hit/miss/error — error = Redis unreachable, served from Postgres).',
    labelNames: ['result'],
  }),
  makeCounterProvider({
    name: AUTH_EVENTS_TOTAL,
    help: 'Auth audit events, by event and outcome.',
    labelNames: ['event', 'outcome'],
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
  ...OUTBOX_SEAM_PROVIDERS,
];
