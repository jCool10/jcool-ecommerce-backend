// Env is already validated (env.validation.ts); the defaults for omitted vars live here.
import {
  appConfig,
  databaseConfig,
  mailConfig,
  observabilityConfig,
  parseIntOr,
  redisConfig,
  resilienceConfig,
  retentionConfig,
  throttleConfig,
} from '@jcool/platform/config';

export default () => ({
  ...appConfig(),
  ...observabilityConfig({ serviceName: 'jcool-api' }),
  ...databaseConfig(),
  ...redisConfig(),
  queue: {
    // Namespaces every queue key, so one Redis can serve several environments without a job written
    // by one being consumed by another.
    prefix: process.env.QUEUE_PREFIX ?? 'bull',
    // Off leaves jobs waiting in Redis (no TTL) rather than losing them, which is what e2e suites
    // want while they drive the processor by hand.
    workerEnabled: process.env.QUEUE_WORKER_ENABLED !== 'false',
    // Each job holds a pg connection for the length of its transaction, so this competes DIRECTLY
    // with the HTTP path for DB_POOL_MAX (default 10) — size the two together rather than raising
    // this alone.
    workerConcurrency: parseIntOr(process.env.QUEUE_WORKER_CONCURRENCY, 5),
    // Deliveries before a message is dead-lettered, the first included. Capped at 10 in the env
    // schema: the backoff below doubles, so the tail grows faster than the count suggests. Eight
    // spans roughly two minutes, which an order expiry needs — past it the session that can still
    // charge for a released order stays open until someone replays the dead letter. That figure
    // holds only because the gateway handlers fail fast under the breaker; with BREAKER_ENABLED=false
    // the attempts wait out the provider SDK and the ladder stretches well past it.
    consumerAttempts: parseIntOr(process.env.QUEUE_CONSUMER_ATTEMPTS, 8),
    // First retry delay; each further one doubles it. 1s through 64s at the defaults — long enough
    // to ride out a restart or a provider outage, short enough that a poison message reaches the
    // dead-letter queue while the deploy that caused it is still the obvious suspect.
    consumerBackoffMs: parseIntOr(process.env.QUEUE_CONSUMER_BACKOFF_MS, 1000),
    // order.paid starts on the same backoff, doubling up to this cap: at the defaults it rides out a
    // user-service outage of 30 minutes before the dead-letter queue.
    orderPaidAttempts: parseIntOr(process.env.ORDER_PAID_CONSUMER_ATTEMPTS, 15),
    orderPaidBackoffCapMs: parseIntOr(process.env.ORDER_PAID_CONSUMER_BACKOFF_CAP_MS, 300_000),
  },
  outbox: {
    // Off leaves rows unpublished rather than losing them, which is what e2e suites want while they
    // assert on them.
    relayEnabled: process.env.OUTBOX_RELAY_ENABLED !== 'false',
    pollMs: parseIntOr(process.env.OUTBOX_POLL_MS, 1000),
    // Rows per tick. Also caps how long one transaction holds its row locks, since the publish runs
    // inside it.
    batchSize: parseIntOr(process.env.OUTBOX_BATCH_SIZE, 100),
  },
  auth: {
    jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
    // Short by design: it caps exposure if the jti denylist is ever bypassed.
    jwtAccessTtl: process.env.JWT_ACCESS_TTL ?? '5m',
    refreshTokenTtl: process.env.REFRESH_TOKEN_TTL ?? '7d',
    emailVerificationTtl: process.env.EMAIL_VERIFICATION_TTL ?? '24h',
    // Short by design: a reset link is a high-value credential.
    passwordResetTtl: process.env.PASSWORD_RESET_TTL ?? '1h',
    // When true, an unverified account gets a 403 after correct credentials.
    requireVerifiedEmail: process.env.AUTH_REQUIRE_VERIFIED_EMAIL === 'true',
    // 'redis' reads the epochs the user-service publishes; this database stops being their source.
    epochSource: process.env.AUTH_EPOCH_SOURCE ?? 'db',
    hs256Enabled: process.env.AUTH_HS256_ENABLED !== 'false',
    // Off answers 410 on every /auth route once the gateway sends them to the user-service.
    routesEnabled: process.env.AUTH_ROUTES_ENABLED !== 'false',
    jwksUrl: process.env.AUTH_JWKS_URL,
    issuer: process.env.JWT_ISSUER,
    audience: process.env.JWT_AUDIENCE,
  },
  userService: {
    internalUrl: process.env.USER_SERVICE_INTERNAL_URL,
    internalApiToken: process.env.INTERNAL_API_TOKEN,
    // Sits on the request path whenever an epoch misses Redis.
    timeoutMs: parseIntOr(process.env.USER_SERVICE_TIMEOUT_MS, 500),
  },
  userDirectory: {
    source: process.env.USER_DIRECTORY_SOURCE ?? 'local',
    notFoundGrace: process.env.USER_DIRECTORY_NOT_FOUND_GRACE ?? '10m',
  },
  identity: {
    // No default, like jwtAccessSecret: the env schema requires it, so a boot reaching here has it.
    bucketKey: process.env.IDENTITY_BUCKET_KEY,
  },
  ...mailConfig(),
  argon2: {
    // OWASP-minimum argon2id params (m=19 MiB, t=2, p=1).
    memoryCost: parseInt(process.env.ARGON2_MEMORY_COST ?? '19456', 10),
    timeCost: parseInt(process.env.ARGON2_TIME_COST ?? '2', 10),
    parallelism: parseInt(process.env.ARGON2_PARALLELISM ?? '1', 10),
  },
  ...throttleConfig(),
  payment: {
    // Declared but never dispatched on: payment.module.ts constructs Stripe unconditionally. This
    // survives as a boot-time assertion — env.validation rejects anything but 'stripe', so a deploy
    // that thinks it configured another gateway fails loudly instead of silently getting Stripe.
    provider: process.env.PAYMENT_PROVIDER ?? 'stripe',
    // Undefined → the Stripe adapter refuses to construct (fail-fast).
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET,
    // Timestamp tolerance (s) for webhook replay defence; 300s matches Stripe's default.
    webhookToleranceSec: parseIntOr(process.env.PAYMENT_WEBHOOK_TOLERANCE_SEC, 300),
    // Unset → the adapter stays on its network-free coded path (fabricated cs_...). Set to
    // sk_test_.../sk_live_... to create real Checkout Sessions a webhook can settle.
    secretKey: process.env.STRIPE_SECRET_KEY,
    // No default: an unset var stays undefined and trips the adapter's live-key fail-fast, so a
    // missing success URL is caught at boot instead of on a real buyer's post-charge redirect. The
    // cancel default below is not guarded that way, but it is reached before any money moves.
    successUrl: process.env.STRIPE_SUCCESS_URL,
    cancelUrl: process.env.STRIPE_CANCEL_URL ?? 'http://localhost:3000/payments/cancel',
  },
  reconcile: {
    // Off for e2e suites, which drive the use case directly, and for one-off job containers.
    enabled: process.env.RECONCILE_ENABLED !== 'false',
    intervalMs: parseIntOr(process.env.RECONCILE_INTERVAL_MS, 60_000),
    batchSize: parseIntOr(process.env.RECONCILE_BATCH_SIZE, 50),
    // Below this age an order is still waiting on a webhook probably in flight; polling burns a call.
    staleAfterSec: parseIntOr(process.env.ORDER_STALE_THRESHOLD_SEC, 120),
    // Matches INVENTORY_RESERVATION_TTL, so an order never outlives the stock hold it depends on.
    orderTtlSec: parseIntOr(process.env.ORDER_TTL_SEC, 900),
  },
  reservationSweep: {
    enabled: process.env.RESERVATION_SWEEP_ENABLED !== 'false',
    intervalMs: parseIntOr(process.env.RESERVATION_SWEEP_INTERVAL_MS, 60_000),
    batchSize: parseIntOr(process.env.RESERVATION_SWEEP_BATCH_SIZE, 50),
    // Extra age past a hold's `expires_at` before this sweep expires the order. A full ORDER_TTL_SEC
    // by default, so the gateway-driven reconcile — the only sweep that can also close the checkout
    // session — always gets there first, and this one only clears what that could not settle.
    graceSec: parseIntOr(process.env.RESERVATION_SWEEP_GRACE_SEC, 900),
  },
  retention: {
    ...retentionConfig().retention,
    // Off leaves the three auth-token tables alone while they are copied between databases.
    authTokensEnabled: process.env.RETENTION_AUTH_TOKENS_ENABLED !== 'false',
    // Extra age past an idempotency key's own `expires_at`. Its TTL is already the retry window, so
    // this is only slack for clock skew between app and database.
    idempotencyGraceSec: parseIntOr(process.env.RETENTION_IDEMPOTENCY_GRACE_SEC, 3_600),
    // Short: a spent single-use token has no use beyond answering a support question about a link
    // clicked last week.
    authTokenGraceDays: parseIntOr(process.env.RETENTION_AUTH_TOKEN_GRACE_DAYS, 7),
    // Grace past REVOCATION for refresh tokens, deliberately much longer: a revoked token that
    // comes back is the reuse signal, and that detection is a row lookup. Floored at 30 days in
    // env.validation.
    refreshTokenGraceDays: parseIntOr(process.env.RETENTION_REFRESH_TOKEN_GRACE_DAYS, 30),
    // How long a PUBLISHED outbox row is kept. Unpublished rows are never collected at any age.
    outboxDays: parseIntOr(process.env.RETENTION_OUTBOX_DAYS, 30),
    // How long an inbox claim is kept — the one retention number that is a correctness bound.
    // Guarded at boot against the main queue's failed-job horizon (see sweep-inbox.ts).
    inboxDays: parseIntOr(process.env.RETENTION_INBOX_DAYS, 30),
    // Must outlast the GATEWAY's redelivery window, not the queue's — this table is the replay
    // defence at ingress. Stripe retries for ~72h; floored at 14 days in env.validation.
    webhookEventDays: parseIntOr(process.env.RETENTION_WEBHOOK_EVENT_DAYS, 30),
  },
  catalog: {
    // Catalog's own fresh window; the stale window, jitter and lock bounds below are shared. The
    // upper bound on staleness after a missed invalidation is this plus those two, not this alone.
    cacheTtlSec: parseIntOr(process.env.CATALOG_CACHE_TTL_SEC, 60),
  },
  // Held in milliseconds: the jittered expiry needs finer resolution than the seconds the env vars use.
  cache: {
    softTtlMs: parseIntOr(process.env.CACHE_SOFT_TTL_SEC, 60) * 1000,
    // How much longer it may be served while a rebuild runs behind it — the window that keeps a
    // reader from ever waiting on Postgres. Past soft + stale the key is gone and the next read blocks.
    staleWindowMs: parseIntOr(process.env.CACHE_STALE_WINDOW_SEC, 30) * 1000,
    // Random spread on each key's expiry, so keys written in one wave do not expire in one wave.
    jitterMs: parseIntOr(process.env.CACHE_TTL_JITTER_SEC, 10) * 1000,
    // Rebuild-lock lease. Must stay above the p99 of cache_rebuild_duration_seconds: a lease that
    // expires mid-rebuild lets a second holder in and the herd back.
    leaseMs: parseIntOr(process.env.CACHE_LOCK_LEASE_MS, 5000),
    // How long a reader that lost the lock waits for the winner's value before reading through to
    // Postgres itself. This caps what single-flight can absorb: a rebuild slower than this times
    // every waiter out and the herd arrives anyway. Rising lock_timeout is that failure, and the
    // fix is a faster rebuild or a longer wait, not a longer lease.
    waitMs: parseIntOr(process.env.CACHE_LOCK_WAIT_MS, 500),
  },
  search: {
    // Off unless explicitly on: the index is derived from Postgres and only ever an extra read
    // path, so nothing boots or tests against a required engine.
    enabled: process.env.SEARCH_ENABLED === 'true',
    url: process.env.SEARCH_URL ?? 'http://localhost:7700',
    // Undefined → keyless engine, which the engine permits only outside its production mode.
    apiKey: process.env.SEARCH_API_KEY,
  },
  storage: {
    // Presence of the whole group is the switch, like SMTP_URL: set → a real bucket, unset → the
    // media routes fail loudly and everything else boots (and a boot failure in production).
    endpoint: process.env.STORAGE_ENDPOINT,
    bucket: process.env.STORAGE_BUCKET,
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
    // R2 ignores the region but the SDK signs with it, so "auto" is the value R2 documents.
    region: process.env.STORAGE_REGION ?? 'auto',
    // Set → stable public URLs served by a bucket domain or CDN; unset → a presigned GET per read.
    publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL,
    // Lifetime of a presigned upload URL, and of a read URL where there is no public base. It caps
    // how long an admin has to push bytes, bounding the window an abandoned upload can occupy.
    presignTtlSec: parseIntOr(process.env.STORAGE_PRESIGN_TTL_SEC, 900),
  },
  media: {
    // How long an asset may sit at PENDING before the sweep reclaims it. Longer than the presign
    // TTL on purpose: the URL must die before the row does, or a sweep and an upload can overlap.
    uploadTtlSec: parseIntOr(process.env.MEDIA_UPLOAD_TTL_SEC, 3600),
    // How long an uploaded-but-unattached asset survives. Never null: an asset without an expiry is
    // one the sweep can never select, so it would outlive the product it was uploaded for.
    readyTtlSec: parseIntOr(process.env.MEDIA_READY_TTL_SEC, 86_400),
    // Enforced at `complete`, by HEAD — a v4 signature pins Content-Length to an exact value, not a
    // ceiling, so the bucket cannot refuse an oversized PUT. What it does bound is the blast radius:
    // an oversized object is refused a place in the catalog and reclaimed by the sweep.
    maxBytes: parseIntOr(process.env.MEDIA_MAX_BYTES, 5 * 1024 * 1024),
  },
  ...resilienceConfig(),
  inventory: {
    // 'pessimistic' (SELECT ... FOR UPDATE) or 'optimistic' (version CAS + retry).
    lockStrategy: process.env.INVENTORY_LOCK_STRATEGY ?? 'pessimistic',
    // How far ahead a HELD reservation stamps `expiresAt` — the deadline the expiry sweep reclaims
    // an unpaid hold from.
    reservationTtl: process.env.INVENTORY_RESERVATION_TTL ?? '15m',
    // Re-CAS attempts after losing a version race before giving up with a 409 (0 = never retry).
    // Real shortfalls never consume a retry. A NaN budget would leave the CAS loop unbounded, so
    // this must never fall through to a bare parseInt.
    optimisticMaxRetries: parseIntOr(process.env.INVENTORY_OPTIMISTIC_MAX_RETRIES, 3),
  },
});
