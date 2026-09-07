import { plainToInstance, Type } from 'class-transformer';
import {
  IsBooleanString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';
import { MIN_BUCKET_KEY_LENGTH } from '@shared/identity/email-bucket';

// Enum so an unexpected NODE_ENV fails validation instead of enabling wrong behavior.
export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

// pino log levels (ascending severity). Default applied in configuration.ts.
export enum LogLevel {
  Trace = 'trace',
  Debug = 'debug',
  Info = 'info',
  Warn = 'warn',
  Error = 'error',
}

// Stock-reservation concurrency strategy. Default applied in configuration.ts.
export enum InventoryLockStrategy {
  Pessimistic = 'pessimistic',
  Optimistic = 'optimistic',
}

// Payment gateway selected at boot; Stripe is the coded path, SePay an interface-only seam.
export enum PaymentProvider {
  Stripe = 'stripe',
  Sepay = 'sepay',
}

/** Environment schema, validated once at startup (fail-fast) — required: NODE_ENV, DATABASE_URL, REDIS_URL, JWT_ACCESS_SECRET, IDENTITY_BUCKET_KEY; optional vars fall back to defaults applied in configuration.ts. */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV!: NodeEnv;

  // Defaults to 3000 (configuration.ts); when present must be a valid TCP port.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT?: number;

  // Grace period (ms) the process keeps returning /health/ready 503 after SIGTERM before the
  // HTTP server closes, so a load balancer drains this instance first. Default 0 (configuration.ts)
  // → instant shutdown in tests/dev; set a few seconds under an orchestrator.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  SHUTDOWN_GRACE_PERIOD_MS?: number;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  // Overrides where the migration runner looks for .sql files; the production image sets it because
  // it ships migrations/ without the src/ tree. Read by the migrate CLI outside Nest, declared here
  // to fail-fast if blank (same reason as the OTEL_*/SENTRY_* vars instrumentation.ts reads raw).
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  MIGRATIONS_DIR?: string;

  // App-side pg pool bounds; validated so an out-of-range value fails at boot.
  // Defaults (10 / 5000ms / 10000ms) applied in configuration.ts. Timeouts allow 0
  // to opt back into pg's native behavior (0 = wait forever / never reap idle).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  DB_POOL_MAX?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  DB_POOL_CONNECTION_TIMEOUT_MS?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  DB_POOL_IDLE_TIMEOUT_MS?: number;

  @IsString()
  @IsNotEmpty()
  REDIS_URL!: string;

  // BullMQ key prefix; default 'bull' (configuration.ts). @IsNotEmpty because a blank prefix would
  // silently produce a different, colliding key layout rather than falling back to the default.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  QUEUE_PREFIX?: string;

  // Consumer kill-switch; on by default (configuration.ts). Off leaves jobs queued, never lost.
  @IsOptional()
  @IsBooleanString()
  QUEUE_WORKER_ENABLED?: string;

  // Jobs consumed in parallel; default 5 (configuration.ts). The cap is a sanity bound, NOT a
  // guarantee against the pool: each in-flight job holds a connection for its transaction, so this
  // and DB_POOL_MAX have to be sized against each other.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  QUEUE_WORKER_CONCURRENCY?: number;

  // Deliveries before a message is dead-lettered; default 8 (configuration.ts). Capped at 10 rather
  // than left open because the backoff doubles: ten tries already stretch the last wait past eight
  // minutes, and a message nobody can apply belongs in the DLQ long before that.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  QUEUE_CONSUMER_ATTEMPTS?: number;

  // First retry delay in ms; default 1000 (configuration.ts). Min 100 so a typo cannot turn the
  // retry budget into a tight loop against whatever dependency is already failing.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(60_000)
  QUEUE_CONSUMER_BACKOFF_MS?: number;

  // Outbox relay kill-switch; on by default (configuration.ts).
  @IsOptional()
  @IsBooleanString()
  OUTBOX_RELAY_ENABLED?: string;

  // Relay period (ms); default 1000 (configuration.ts). Min 100 so a typo cannot turn the relay into
  // a busy loop opening transactions against the outbox table.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  OUTBOX_POLL_MS?: number;

  // Rows per relay tick; default 100 (configuration.ts). Capped because the publish happens inside
  // the polling transaction, so the batch size is also how long row locks are held.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  OUTBOX_BATCH_SIZE?: number;

  @IsOptional()
  @IsBooleanString()
  SWAGGER_ENABLED?: string;

  // pino log level; defaults to debug in dev, info in prod (configuration.ts).
  @IsOptional()
  @IsEnum(LogLevel)
  LOG_LEVEL?: LogLevel;

  // `service` on every log line; falls back to OTEL_SERVICE_NAME then 'jcool-api'
  // (configuration.ts). @IsNotEmpty so a blank value fails at boot instead of shipping "" as the
  // service label on every line.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  LOG_SERVICE_NAME?: string;

  // `version` on every log line — the deploy identifier. Falls back to the platform-supplied
  // RAILWAY_GIT_COMMIT_SHA, then 'dev' (configuration.ts). RAILWAY_* is not validated here: the
  // platform owns it, it is not part of this app's env contract.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  APP_VERSION?: string;

  // Duration (ms) above which the canonical request line is emitted at `warn` with `slow: true`;
  // default 1000 (configuration.ts). Min 1 because a 0 would mark every request slow, which turns
  // the warn level — the thing alerts are built on — into the default for all traffic.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  LOG_SLOW_REQUEST_MS?: number;

  // Bearer token for GET /metrics (ADR-0018); optional in dev, MinLength keeps it non-trivial.
  @IsOptional()
  @IsString()
  @MinLength(16)
  METRICS_TOKEN?: string;

  // Tracing kill-switch (ADR-0015); the OTel SDK (instrumentation.ts) starts only when "true".
  @IsOptional()
  @IsBooleanString()
  OTEL_ENABLED?: string;

  // service.name on every span; read in instrumentation.ts, declared here to fail-fast if invalid.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  OTEL_SERVICE_NAME?: string;

  // OTLP/HTTP base endpoint of the Collector; the traces path (/v1/traces) is appended.
  // Defaults to http://localhost:4318 (instrumentation.ts).
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;

  // Sentry DSN (ADR-0016); unset (dev/test) → the SDK never initializes and captureException is a
  // silent no-op. Read in instrumentation.ts; declared here to fail-fast if blank.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  SENTRY_DSN?: string;

  // Fraction (0–1) of transactions sampled for Sentry performance; 0/absent → errors only (no perf
  // spans, so no duplicate http spans in Jaeger — see instrumentation.ts).
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  SENTRY_TRACES_SAMPLE_RATE?: number;

  // Public base URL for links in outbound email; plain string so localhost/non-TLD hosts validate.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  APP_PUBLIC_URL?: string;

  // Overrides the Secure flag on auth cookies; defaults to on in production only.
  @IsOptional()
  @IsBooleanString()
  COOKIE_SECURE?: string;

  // Comma-separated CORS allow-list; empty means CORS disabled (same-origin only).
  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  // Express `trust proxy` for req.ip (throttle + audit); off unless set. Accepts a hop
  // count, a subnet/CSV, or "true"/"false".
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  TRUST_PROXY?: string;

  // Rate-limiting kill-switch; defaults to enabled (configuration.ts).
  @IsOptional()
  @IsBooleanString()
  THROTTLE_ENABLED?: string;

  @IsOptional()
  @IsBooleanString()
  RECONCILE_ENABLED?: string;

  // Sweep period (ms); default 60000 (configuration.ts). Min 1000 so a typo can't turn the sweep
  // into a busy loop hammering the payment gateway.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  RECONCILE_INTERVAL_MS?: number;

  // Orders per sweep tick; default 50 (configuration.ts). Capped so one tick can't fan out an
  // unbounded number of gateway round-trips.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  RECONCILE_BATCH_SIZE?: number;

  // Minimum age (s) before a PENDING order is swept; default 120 (configuration.ts). 0 is legal —
  // e2e drives the sweep deterministically.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  ORDER_STALE_THRESHOLD_SEC?: number;

  // Age (s) after which an unsettled PENDING order is expired and its stock released; default 900
  // (configuration.ts), matching the reservation TTL.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  ORDER_TTL_SEC?: number;

  @IsOptional()
  @IsBooleanString()
  RESERVATION_SWEEP_ENABLED?: string;

  // Sweep period (ms); default 60000 (configuration.ts). Min 1000 so a typo can't turn the sweep
  // into a busy loop opening transactions.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  RESERVATION_SWEEP_INTERVAL_MS?: number;

  // Reservation rows per sweep tick; default 50 (configuration.ts). Capped because each distinct
  // order in the batch costs a finalize transaction, so one tick can't run unbounded.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  RESERVATION_SWEEP_BATCH_SIZE?: number;

  // Extra age (s) past a hold's expiry before the sweep claims it; default 900 (configuration.ts),
  // keeping it behind the gateway-driven reconcile. 0 is legal — e2e drives the sweep deterministically.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  RESERVATION_SWEEP_GRACE_SEC?: number;

  // Catalog's fresh window (s); default 60 (configuration.ts). Total staleness is this plus
  // CACHE_STALE_WINDOW_SEC plus CACHE_TTL_JITTER_SEC. Min 1 — a 0 would make every entry stale the
  // instant it is written, turning every read into a stale serve plus a background rebuild.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  CATALOG_CACHE_TTL_SEC?: number;

  // Stampede-protected cache windows; defaults 60s / 30s / 10s (configuration.ts). Min 1 on the
  // fresh window because a 0 makes every entry stale the instant it is written, turning every read
  // into a stale serve plus a background rebuild. The other two accept 0, which switches off
  // stale-serving (resp. jitter) — switching off SWR takes both, since jitter also outlives freshness.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  CACHE_SOFT_TTL_SEC?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  CACHE_STALE_WINDOW_SEC?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  CACHE_TTL_JITTER_SEC?: number;

  // Rebuild-lock lease (ms); default 5000 (configuration.ts). Min 100 because a lease shorter than a
  // rebuild admits a second holder on every refill, which is the stampede this lock exists to stop.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  CACHE_LOCK_LEASE_MS?: number;

  // How long a reader waits for the lock holder's value (ms); default 500 (configuration.ts).
  // 0 is legal — it opts out of waiting and reads through to Postgres immediately.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  CACHE_LOCK_WAIT_MS?: number;

  // Catalog search kill-switch; off unless "true" (configuration.ts), so dev, unit tests and any
  // boot without a search engine still start — the index is a derived read path, never required.
  @IsOptional()
  @IsBooleanString()
  SEARCH_ENABLED?: string;

  // Search engine base URL; default http://localhost:7700 (configuration.ts). @IsNotEmpty so a
  // blank value fails at boot instead of silently falling back to the local default.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  SEARCH_URL?: string;

  // Search engine master/admin key. Optional because a local engine may run keyless; MinLength
  // keeps it non-trivial where it is set (same reasoning as METRICS_TOKEN).
  @IsOptional()
  @IsString()
  @MinLength(16)
  SEARCH_API_KEY?: string;

  // Circuit-breaker kill-switch; on by default (configuration.ts). Off passes every guarded call
  // straight through to its downstream.
  @IsOptional()
  @IsBooleanString()
  BREAKER_ENABLED?: string;

  // How long one outbound call may run before it is abandoned (ms); default 3000 (configuration.ts).
  // Min 100 so a typo cannot make every call time out before the downstream can possibly answer.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  BREAKER_TIMEOUT_MS?: number;

  // Failure share that opens the circuit; default 50 (configuration.ts). The share is compared
  // strictly, so 100 never opens however many calls fail — capped at 99 so a breaker that reads as
  // configured cannot in fact be switched off. At the low end 1 opens on the first failure once the
  // window holds enough calls to count.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  BREAKER_ERROR_THRESHOLD_PCT?: number;

  // How long the circuit stays open before a trial call (ms); default 10000 (configuration.ts).
  // Min 100 keeps the open state from being so brief it never sheds any load.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  BREAKER_RESET_TIMEOUT_MS?: number;

  // Window the failure share is measured over (ms); default 10000 (configuration.ts). Min 1000 —
  // a window shorter than the calls it counts would forget each failure before the next arrives.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  BREAKER_ROLLING_WINDOW_MS?: number;

  // Calls the window needs before the share counts; default 5 (configuration.ts). 0 and 1 behave
  // identically — one failure is then the whole window — so the floor only rules out the value that
  // reads as "no gate at all".
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  BREAKER_VOLUME_THRESHOLD?: number;

  // Stock-reservation locking strategy; defaults to pessimistic (configuration.ts).
  @IsOptional()
  @IsEnum(InventoryLockStrategy)
  INVENTORY_LOCK_STRATEGY?: InventoryLockStrategy;

  // How far ahead a HELD reservation stamps expires_at ("15m"/"1h"); default in configuration.ts.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  INVENTORY_RESERVATION_TTL?: string;

  // Optimistic reserve retry budget after a lost version CAS; default 3 (configuration.ts).
  // Capped so a misconfig can't blow up 2^attempt backoff and pin the stock row's write-lock.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
  INVENTORY_OPTIMISTIC_MAX_RETRIES?: number;

  // Base backoff (ms) between optimistic retries; default 20 (configuration.ts).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  INVENTORY_OPTIMISTIC_BACKOFF_MS?: number;

  // Payment gateway; defaults to stripe (configuration.ts). Stripe is the only coded adapter.
  @IsOptional()
  @IsEnum(PaymentProvider)
  PAYMENT_PROVIDER?: PaymentProvider;

  // Webhook signing secret. Optional here so a boot that doesn't touch payments isn't blocked;
  // the Stripe adapter fail-fasts at construction when it's absent. MinLength keeps it non-trivial.
  @IsOptional()
  @IsString()
  @MinLength(16)
  PAYMENT_WEBHOOK_SECRET?: string;

  // Replay window (seconds) for the webhook timestamp tolerance; default 300 (configuration.ts).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  PAYMENT_WEBHOOK_TOLERANCE_SEC?: number;

  // Live Stripe secret key (sk_test_.../sk_live_...). Optional: absent → the adapter uses its
  // network-free coded path; present → createSession calls the real Stripe API.
  @IsOptional()
  @IsString()
  @MinLength(8)
  STRIPE_SECRET_KEY?: string;

  // Post-checkout redirect targets. String (not @IsUrl): the success default carries Stripe's
  // {CHECKOUT_SESSION_ID} brace template, which strict URL validation would reject.
  @IsOptional()
  @IsString()
  STRIPE_SUCCESS_URL?: string;

  @IsOptional()
  @IsString()
  STRIPE_CANCEL_URL?: string;

  // HMAC secret for access tokens; MinLength(32) enforces a ~256-bit floor for HS256 (no default → missing fails boot).
  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET!: string;

  // HMAC key behind the routing bucket in every user-context id. PERMANENT — rotating it routes
  // every existing account to a shard that does not hold its rows, and old buckets are not
  // recomputable. Back it up with the same rank as the database.
  // MinLength gates length, not entropy: a long passphrase is brute-forceable from a few
  // self-registered (email, bucket) pairs. Generate with `openssl rand -base64 48`.
  @IsString()
  @MinLength(MIN_BUCKET_KEY_LENGTH)
  IDENTITY_BUCKET_KEY!: string;

  // TTLs in "15m"/"7d" string form; defaults applied in configuration.ts.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_TTL?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  REFRESH_TOKEN_TTL?: string;

  // Email-verification token lifetime ("24h"/"30m"); default applied in configuration.ts.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  EMAIL_VERIFICATION_TTL?: string;

  // Password-reset token lifetime ("1h"/"30m"); default applied in configuration.ts.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  PASSWORD_RESET_TTL?: string;

  // Gate login on a verified email; defaults to disabled (configuration.ts).
  @IsOptional()
  @IsBooleanString()
  AUTH_REQUIRE_VERIFIED_EMAIL?: string;

  // Argon2id cost overrides; validated here so an out-of-range value fails at boot.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  ARGON2_MEMORY_COST?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  ARGON2_TIME_COST?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  ARGON2_PARALLELISM?: number;
}

// ConfigModule `validate` hook — throws on any violation so the process exits at boot.
export function validate(config: Record<string, unknown>): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: false,
  });

  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map((error) => {
        const constraints = Object.values(error.constraints ?? {}).join(', ');
        return `${error.property}: ${constraints}`;
      })
      .join('; ');
    throw new Error(`Environment validation failed -> ${details}`);
  }

  return validated;
}
