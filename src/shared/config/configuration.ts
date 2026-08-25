// Typed config factory grouped by concern; callers read via config.get('app.port').
// Env is already validated (env.validation.ts). Defaults applied here when omitted.

// Express `trust proxy` value: false (off), true (trust all — spoofable), a hop count,
// or a subnet/CSV. Off unless TRUST_PROXY is set.
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  const hops = Number(raw);
  return Number.isInteger(hops) && hops >= 0 ? hops : raw;
}

// parseInt that treats an unset OR blank/whitespace var as absent (→ fallback) and
// never returns NaN. A NaN pool timeout is falsy to pg, which silently reverts to
// wait-forever/never-reap — defeating the bound. class-validator coerces "" to 0 and
// passes @Min(0), so the guard must live here where the raw string is read.
function intEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// Sentry performance sampling: a positive fraction enables tracing; 0/absent → errors only. Returns
// undefined (never literal 0) so callers can omit the key — an explicit 0 turns Sentry's own http
// spans on and duplicates our OTel spans (see instrumentation.ts).
function parseTracesSampleRate(raw: string | undefined): number | undefined {
  const rate = Number(raw);
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

// parseInt that falls back on absent/empty/non-numeric input. Guards the empty-string→NaN env
// gotcha; critical for the webhook replay window, where a silent NaN would disable replay defense.
function parseIntOr(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default () => ({
  app: {
    env: process.env.NODE_ENV,
    port: parseInt(process.env.PORT ?? '3000', 10),
    // Fail-safe: on in dev/test, off in production unless SWAGGER_ENABLED=true.
    swaggerEnabled:
      process.env.SWAGGER_ENABLED === 'true' ||
      (process.env.SWAGGER_ENABLED !== 'false' && process.env.NODE_ENV !== 'production'),
    // Secure flag on auth cookies: on in production, off elsewhere (so http dev/e2e round-trips); COOKIE_SECURE overrides.
    cookieSecure: process.env.COOKIE_SECURE
      ? process.env.COOKIE_SECURE === 'true'
      : process.env.NODE_ENV === 'production',
    // Cross-origin allow-list (comma-separated); empty → CORS off (same-origin only), the safe default.
    corsOrigins: (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    // Public base URL used to build links in outbound email (verification, etc.).
    publicUrl: process.env.APP_PUBLIC_URL ?? 'http://localhost:3000',
    // Reverse-proxy trust for req.ip (throttle + audit). Off by default (anti-spoof); set behind a trusted proxy.
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    // How long /health/ready keeps 503-ing after SIGTERM before the server closes (graceful
    // drain). 0 = shut down immediately (tests/dev); set ~5000 under a load balancer.
    shutdownGracePeriodMs: parseInt(process.env.SHUTDOWN_GRACE_PERIOD_MS ?? '0', 10),
  },
  log: {
    // pino level: verbose in dev, lean in prod; LOG_LEVEL overrides either way.
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  },
  metrics: {
    // Bearer token for GET /metrics. Undefined → open in dev, hidden in prod (MetricsTokenGuard).
    token: process.env.METRICS_TOKEN,
  },
  tracing: {
    // Mirrors instrumentation.ts (which reads process.env directly, before this runs) for a typed config surface.
    enabled: process.env.OTEL_ENABLED === 'true',
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'jcool-api',
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318',
  },
  sentry: {
    // Typed mirror of the Sentry gating in instrumentation.ts (which inits before this runs).
    enabled: Boolean(process.env.SENTRY_DSN),
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    // Positive fraction → performance tracing; 0/absent → error-only (undefined, not literal 0).
    tracesSampleRate: parseTracesSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
  },
  database: {
    url: process.env.DATABASE_URL,
    // App-side pg pool bounds — the stack has no external pooler (a PgBouncer drop-in
    // is owned by deploy), so these cap the backend connections Postgres faces.
    poolMax: intEnv(process.env.DB_POOL_MAX, 10),
    // Fail an acquire after this long instead of pg's default of waiting forever, so a
    // saturated pool surfaces as a fast failure rather than an unbounded request backlog.
    connectionTimeoutMs: intEnv(process.env.DB_POOL_CONNECTION_TIMEOUT_MS, 5000),
    idleTimeoutMs: intEnv(process.env.DB_POOL_IDLE_TIMEOUT_MS, 10000),
  },
  redis: {
    url: process.env.REDIS_URL,
  },
  queue: {
    // BullMQ key prefix. Namespaces every queue key so one Redis can serve several environments
    // without a job written by one being consumed by another.
    prefix: process.env.QUEUE_PREFIX ?? 'bull',
    // OPT-IN, deliberately. A consume that fails gets no retry yet, and by then the outbox row is
    // already marked published — so a transient database error would leave the event unapplied with
    // nothing to replay it. Off, the jobs simply wait in Redis (no TTL) until a process with a retry
    // and dead-letter path turns this on.
    workerEnabled: process.env.QUEUE_WORKER_ENABLED === 'true',
    // Jobs one worker applies at a time. Each holds a pg connection for the length of its
    // transaction, so this competes DIRECTLY with the HTTP path for DB_POOL_MAX (default 10) —
    // size the two together rather than raising this alone.
    workerConcurrency: parseIntOr(process.env.QUEUE_WORKER_CONCURRENCY, 5),
  },
  outbox: {
    // Relay kill-switch; on by default. Off leaves rows unpublished rather than losing them, which
    // is what e2e suites want while they assert on them.
    relayEnabled: process.env.OUTBOX_RELAY_ENABLED !== 'false',
    // A blank env value would parseInt->NaN and register a 0ms interval, so fall back explicitly.
    pollMs: parseIntOr(process.env.OUTBOX_POLL_MS, 1000),
    // Rows per tick. Also caps how long one transaction holds its row locks, since the publish runs
    // inside it.
    batchSize: parseIntOr(process.env.OUTBOX_BATCH_SIZE, 100),
  },
  auth: {
    jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
    // Short access-token life (defense-in-depth): caps exposure if the jti denylist is ever bypassed.
    jwtAccessTtl: process.env.JWT_ACCESS_TTL ?? '5m',
    refreshTokenTtl: process.env.REFRESH_TOKEN_TTL ?? '7d',
    // Lifetime of an email-verification token (duration form, e.g. "24h").
    emailVerificationTtl: process.env.EMAIL_VERIFICATION_TTL ?? '24h',
    // Password-reset token lifetime — short by design (high-value credential), defaults to 1h.
    passwordResetTtl: process.env.PASSWORD_RESET_TTL ?? '1h',
    // When true, an unverified account cannot log in (403 after correct creds). Off by default.
    requireVerifiedEmail: process.env.AUTH_REQUIRE_VERIFIED_EMAIL === 'true',
  },
  argon2: {
    // OWASP-minimum argon2id params (m=19 MiB, t=2, p=1); override via env to tune.
    memoryCost: parseInt(process.env.ARGON2_MEMORY_COST ?? '19456', 10),
    timeCost: parseInt(process.env.ARGON2_TIME_COST ?? '2', 10),
    parallelism: parseInt(process.env.ARGON2_PARALLELISM ?? '1', 10),
  },
  throttle: {
    // Rate-limiting kill-switch; on by default (THROTTLE_ENABLED=false disables — load tests, e2e).
    enabled: process.env.THROTTLE_ENABLED !== 'false',
  },
  payment: {
    // Gateway adapter chosen by the DI factory in payment.module.ts. Default 'stripe' (coded path).
    provider: process.env.PAYMENT_PROVIDER ?? 'stripe',
    // Webhook HMAC secret; undefined → the Stripe adapter refuses to construct (fail-fast).
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET,
    // Timestamp tolerance (s) for webhook replay defense; 300s matches Stripe's default. A blank
    // env value would parseInt→NaN and silently disable the replay window, so fall back explicitly.
    webhookToleranceSec: parseIntOr(process.env.PAYMENT_WEBHOOK_TOLERANCE_SEC, 300),
    // Live Stripe API key. Unset → the adapter stays on its network-free coded path (fabricated
    // cs_...). Set to sk_test_.../sk_live_... to create real Checkout Sessions a webhook can settle.
    secretKey: process.env.STRIPE_SECRET_KEY,
    // Where Stripe redirects after checkout. success_url is mandatory for a live session; the
    // {CHECKOUT_SESSION_ID} template is Stripe's own placeholder, expanded on redirect.
    successUrl:
      process.env.STRIPE_SUCCESS_URL ?? 'http://localhost:3000/payments/success?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: process.env.STRIPE_CANCEL_URL ?? 'http://localhost:3000/payments/cancel',
  },
  reconcile: {
    // Off for e2e suites, which drive the use case directly, and for one-off job containers.
    enabled: process.env.RECONCILE_ENABLED !== 'false',
    // A blank env value would parseInt→NaN and register a 0ms interval, so fall back explicitly.
    intervalMs: parseIntOr(process.env.RECONCILE_INTERVAL_MS, 60_000),
    batchSize: parseIntOr(process.env.RECONCILE_BATCH_SIZE, 50),
    // Below this age an order is still waiting on a webhook probably in flight; polling burns a call.
    staleAfterSec: parseIntOr(process.env.ORDER_STALE_THRESHOLD_SEC, 120),
    // Matches INVENTORY_RESERVATION_TTL, so an order never outlives the stock hold it depends on.
    orderTtlSec: parseIntOr(process.env.ORDER_TTL_SEC, 900),
  },
  catalog: {
    // Cache-aside TTL (s) for the public product read paths — also the upper bound on staleness
    // if an invalidation is ever missed. A blank env value would parseInt→NaN and cache forever.
    cacheTtlSec: parseIntOr(process.env.CATALOG_CACHE_TTL_SEC, 60),
  },
  inventory: {
    // Stock-reservation locking strategy: 'pessimistic' (SELECT ... FOR UPDATE) or
    // 'optimistic' (version CAS + retry). Default pessimistic.
    lockStrategy: process.env.INVENTORY_LOCK_STRATEGY ?? 'pessimistic',
    // How long a HELD reservation stamps `expiresAt` ahead (duration form). Written now;
    // the sweep that reclaims an expired unpaid hold is a later concern.
    reservationTtl: process.env.INVENTORY_RESERVATION_TTL ?? '15m',
    // Optimistic reserve: how many times to re-CAS after losing a version race before
    // giving up with a 409 (0 = never retry). Real shortfalls never consume a retry.
    optimisticMaxRetries: parseInt(process.env.INVENTORY_OPTIMISTIC_MAX_RETRIES ?? '3', 10),
    // Base backoff (ms) between optimistic retries; grows 2^attempt and gets random jitter.
    optimisticBackoffMs: parseInt(process.env.INVENTORY_OPTIMISTIC_BACKOFF_MS ?? '20', 10),
  },
});
