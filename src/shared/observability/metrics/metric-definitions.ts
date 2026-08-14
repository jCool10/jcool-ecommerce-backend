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

// Latency buckets (seconds). Qualitative start — re-derived from real k6 p99 in Phase 6 (DoD-19).
export const HTTP_LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
// Order-value buckets in minor units. Qualitative start (VND has no minor unit → dong); re-tuned in Phase 6.
export const ORDER_VALUE_BUCKETS = [
  10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000,
];

/**
 * Every metric registered as an eagerly-instantiated DI provider. Nest instantiates each at
 * bootstrap, so all appear in `/metrics` (HELP/TYPE) even before the first observation —
 * including `catalog_cache_operations_total`, a SEAM: registered now, incremented only once
 * a catalog cache layer lands (BF#5). The outbox seam gauges live in
 * outbox-backlog.collector.ts and report 0 until the BF#4 outbox table exists.
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
    help: 'Catalog cache hits/misses. SEAM: registered now, incremented when a cache layer lands (BF#5).',
    labelNames: ['result'],
  }),
  makeCounterProvider({
    name: AUTH_EVENTS_TOTAL,
    help: 'Auth audit events, by event and outcome.',
    labelNames: ['event', 'outcome'],
  }),
  ...OUTBOX_SEAM_PROVIDERS,
];
