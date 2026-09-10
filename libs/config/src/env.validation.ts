import { plainToInstance, Type } from 'class-transformer';
import {
  IsBooleanString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';
import { MIN_BUCKET_KEY_LENGTH } from '@shared/identity/email-bucket';
import { MIN_INBOX_RETENTION_DAYS } from '@shared/messaging/queue/queue.constants';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export enum LogLevel {
  Trace = 'trace',
  Debug = 'debug',
  Info = 'info',
  Warn = 'warn',
  Error = 'error',
}

export enum InventoryLockStrategy {
  Pessimistic = 'pessimistic',
  Optimistic = 'optimistic',
}

// One member today: the enum earns its place by rejecting any other value at startup instead of
// letting a typo pick a gateway that does not exist.
export enum PaymentProvider {
  Stripe = 'stripe',
}

/**
 * Validated once at startup, so a bad value fails the boot. Every optional var falls back to a
 * default applied in configuration.ts; the comments here only explain the BOUNDS.
 *
 * The shared base: what both deployables need. Each app's own connection string lives on its own
 * subclass — {@link CoreEnvironmentVariables}, {@link UserEnvironmentVariables} — because a required
 * variable here is one every deployment must hold, including the one that has no use for it.
 * Unknown keys are ignored rather than rejected: the e2e harness boots both apps in one process off
 * one `process.env`, so a schema that refused a foreign key would fail on its sibling's variables.
 * That sharing also means this file, not the harness, is where the separation is enforced — a leak
 * here stays invisible until a container boots alone.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV!: NodeEnv;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  SHUTDOWN_GRACE_PERIOD_MS?: number;

  // The timeouts allow 0, which opts back into pg's native behaviour (wait forever / never reap idle).
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

  // @IsNotEmpty because a blank prefix would silently produce a different, colliding key layout
  // rather than falling back to the default.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  QUEUE_PREFIX?: string;

  @IsOptional()
  @IsBooleanString()
  QUEUE_WORKER_ENABLED?: string;

  // The cap is a sanity bound, NOT a guarantee against the pool: each in-flight job holds a
  // connection for its transaction, so this and DB_POOL_MAX have to be sized against each other.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  QUEUE_WORKER_CONCURRENCY?: number;

  // Capped at 10 rather than left open because the backoff doubles: ten tries already stretch the
  // last wait past eight minutes, and a message nobody can apply belongs in the DLQ long before that.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  QUEUE_CONSUMER_ATTEMPTS?: number;

  // Min 100 so a typo cannot turn the retry budget into a tight loop against whatever dependency is
  // already failing.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(60_000)
  QUEUE_CONSUMER_BACKOFF_MS?: number;

  @IsOptional()
  @IsBooleanString()
  OUTBOX_RELAY_ENABLED?: string;

  // Min 100 so a typo cannot turn the relay into a busy loop opening transactions against the
  // outbox table.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  OUTBOX_POLL_MS?: number;

  // Capped because the publish happens inside the polling transaction, so the batch size is also
  // how long row locks are held.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  OUTBOX_BATCH_SIZE?: number;

  @IsOptional()
  @IsBooleanString()
  SWAGGER_ENABLED?: string;

  @IsOptional()
  @IsEnum(LogLevel)
  LOG_LEVEL?: LogLevel;

  @IsOptional()
  @IsString()
  @MinLength(16)
  METRICS_TOKEN?: string;

  // The OTel SDK (instrumentation.ts) starts only when this is "true".
  @IsOptional()
  @IsBooleanString()
  OTEL_ENABLED?: string;

  // service.name on every span; read in instrumentation.ts, declared here so a bad value fails boot.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  OTEL_SERVICE_NAME?: string;

  // Base endpoint of the Collector; the traces path (/v1/traces) is appended to it.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;

  // Unset (dev/test) → the SDK never initializes and captureException is a silent no-op. Read in
  // instrumentation.ts; declared here so a blank value fails boot.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  SENTRY_DSN?: string;

  // Plain string, not @IsUrl, so localhost and other non-TLD hosts validate.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  APP_PUBLIC_URL?: string;

  @IsOptional()
  @IsBooleanString()
  COOKIE_SECURE?: string;

  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  // A hop count, a subnet/CSV, or "true"/"false".
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  TRUST_PROXY?: string;

  @IsOptional()
  @IsBooleanString()
  THROTTLE_ENABLED?: string;

  @IsOptional()
  @IsBooleanString()
  RECONCILE_ENABLED?: string;

  // Min 1000 so a typo can't turn the sweep into a busy loop hammering the payment gateway.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  RECONCILE_INTERVAL_MS?: number;

  // Capped so one tick can't fan out an unbounded number of gateway round-trips.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  RECONCILE_BATCH_SIZE?: number;

  // 0 is legal — e2e drives the sweep deterministically.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  ORDER_STALE_THRESHOLD_SEC?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  ORDER_TTL_SEC?: number;

  @IsOptional()
  @IsBooleanString()
  RESERVATION_SWEEP_ENABLED?: string;

  // Min 1000 so a typo can't turn the sweep into a busy loop opening transactions.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  RESERVATION_SWEEP_INTERVAL_MS?: number;

  // Capped because each distinct order in the batch costs a finalize transaction.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  RESERVATION_SWEEP_BATCH_SIZE?: number;

  // 0 is legal — e2e drives the sweep deterministically.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  RESERVATION_SWEEP_GRACE_SEC?: number;

  @IsOptional()
  @IsBooleanString()
  RETENTION_ENABLED?: string;

  // Min 1000 so a typo can't turn hourly housekeeping into a loop issuing DELETEs as fast as the
  // pool allows.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  RETENTION_INTERVAL_MS?: number;

  // Capped because a larger batch holds row locks on a table the request path is writing to for
  // proportionally longer.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  RETENTION_BATCH_SIZE?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  RETENTION_SWEEP_TIMEOUT_MS?: number;

  // 0 is legal: the key's own TTL is already the retry window, so this is only slack for clock skew.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  RETENTION_IDEMPOTENCY_GRACE_SEC?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  RETENTION_AUTH_TOKEN_GRACE_DAYS?: number;

  // The 30-day floor is not a preference: a revoked token that reappears is the reuse signal. It is
  // only real because the sweep's expiry arm excludes revoked rows — without that exclusion the much
  // shorter RETENTION_AUTH_TOKEN_GRACE_DAYS would collect rotated tokens first.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  RETENTION_REFRESH_TOKEN_GRACE_DAYS?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  RETENTION_OUTBOX_DAYS?: number;

  // A correctness bound: while the queue can still redeliver a message, its claim is the only thing
  // stopping the effect being applied twice. The floor is DERIVED from the queue's failed-job
  // horizon so the pair cannot drift.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_INBOX_RETENTION_DAYS)
  RETENTION_INBOX_DAYS?: number;

  // The floor tracks the GATEWAY's redelivery window (Stripe retries for ~72h), not the queue's.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(14)
  RETENTION_WEBHOOK_EVENT_DAYS?: number;

  // Min 1 — a 0 would make every entry stale the instant it is written, turning every read into a
  // stale serve plus a background rebuild.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  CATALOG_CACHE_TTL_SEC?: number;

  // The stale window and the jitter below accept 0, which switches off stale-serving (resp. jitter);
  // switching off SWR takes both, since jitter also outlives freshness.
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

  // Min 100 because a lease shorter than a rebuild admits a second holder on every refill, which is
  // the stampede this lock exists to stop.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  CACHE_LOCK_LEASE_MS?: number;

  // 0 is legal — it opts out of waiting and reads through to Postgres immediately.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  CACHE_LOCK_WAIT_MS?: number;

  @IsOptional()
  @IsBooleanString()
  SEARCH_ENABLED?: string;

  // @IsNotEmpty so a blank value fails at boot instead of silently falling back to the local default.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  SEARCH_URL?: string;

  // Optional because a local engine may run keyless.
  @IsOptional()
  @IsString()
  @MinLength(16)
  SEARCH_API_KEY?: string;

  // The four storage vars are optional here and required together in StorageModule, which is where
  // "half-configured" can be told apart from "not configured" — a rule per-variable decorators
  // cannot express.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  STORAGE_ENDPOINT?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  STORAGE_BUCKET?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  STORAGE_ACCESS_KEY_ID?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  STORAGE_SECRET_ACCESS_KEY?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  STORAGE_REGION?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  STORAGE_PUBLIC_BASE_URL?: string;

  // Min 60 so an upload has time to finish. It must also stay strictly below MEDIA_UPLOAD_TTL_SEC —
  // a cross-field rule no per-field range can express, so it is checked at boot instead
  // (initiate-upload.use-case.ts).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(3600)
  STORAGE_PRESIGN_TTL_SEC?: number;

  // Min 300 keeps a slow upload from being swept out from under itself.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(300)
  MEDIA_UPLOAD_TTL_SEC?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(300)
  MEDIA_READY_TTL_SEC?: number;

  // Min 1024 rejects a value that would refuse every real image.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1024)
  MEDIA_MAX_BYTES?: number;

  @IsOptional()
  @IsBooleanString()
  BREAKER_ENABLED?: string;

  // Min 100 so a typo cannot make every call time out before the downstream can possibly answer.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  BREAKER_TIMEOUT_MS?: number;

  // The share is compared strictly, so 100 never opens however many calls fail — capped at 99 so a
  // breaker that reads as configured cannot in fact be switched off. At the low end 1 opens on the
  // first failure once the window holds enough calls to count.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  BREAKER_ERROR_THRESHOLD_PCT?: number;

  // Min 100 keeps the open state from being so brief it never sheds any load.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  BREAKER_RESET_TIMEOUT_MS?: number;

  // Min 1000 — a window shorter than the calls it counts would forget each failure before the next
  // arrives.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  BREAKER_ROLLING_WINDOW_MS?: number;

  // 0 and 1 behave identically — one failure is then the whole window — so the floor only rules out
  // the value that reads as "no gate at all".
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  BREAKER_VOLUME_THRESHOLD?: number;

  @IsOptional()
  @IsEnum(InventoryLockStrategy)
  INVENTORY_LOCK_STRATEGY?: InventoryLockStrategy;

  // Duration form ("15m"/"1h").
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  INVENTORY_RESERVATION_TTL?: string;

  // Capped so a misconfig can't spin the CAS loop while it pins the stock row's write-lock.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
  INVENTORY_OPTIMISTIC_MAX_RETRIES?: number;

  @IsOptional()
  @IsEnum(PaymentProvider)
  PAYMENT_PROVIDER?: PaymentProvider;

  // Optional here so a boot that doesn't touch payments isn't blocked; the Stripe adapter
  // fail-fasts at construction when it's absent.
  @IsOptional()
  @IsString()
  @MinLength(16)
  PAYMENT_WEBHOOK_SECRET?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  PAYMENT_WEBHOOK_TOLERANCE_SEC?: number;

  @IsOptional()
  @IsString()
  @MinLength(8)
  STRIPE_SECRET_KEY?: string;

  // String, not @IsUrl: the operator's value carries Stripe's {CHECKOUT_SESSION_ID} brace
  // template, which strict URL validation would reject.
  @IsOptional()
  @IsString()
  STRIPE_SUCCESS_URL?: string;

  @IsOptional()
  @IsString()
  STRIPE_CANCEL_URL?: string;

  // The verifying half of the ES256 access-token keypair, a PEM or the base64 of one. Every app
  // needs it; only the issuer holds the private half (UserEnvironmentVariables).
  @IsString()
  @IsNotEmpty()
  JWT_ES256_PUBLIC_KEY!: string;

  // `kid` on every token. Bump it in the same release that swaps the keypair.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  JWT_KEY_ID?: string;

  // Duration form. Must stay at or above REFRESH_TOKEN_TTL — see configuration.ts.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  AUTH_EPOCH_REDIS_TTL?: string;

  // The four token TTLs below take duration form ("15m"/"7d").
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_TTL?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  REFRESH_TOKEN_TTL?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  EMAIL_VERIFICATION_TTL?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  PASSWORD_RESET_TTL?: string;

  @IsOptional()
  @IsBooleanString()
  AUTH_REQUIRE_VERIFIED_EMAIL?: string;

  // Connection URL (smtp://user:pass@host:587).
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  SMTP_URL?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  MAIL_FROM?: string;

  // Capped below BullMQ's 30s job lock, which the order-confirmation send runs inside: past that the
  // queue reclaims the job mid-send, and the original delivery — already applied, already sent —
  // finishes without its lock and is filed as a dead letter.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(25_000)
  MAIL_TIMEOUT_MS?: number;

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

/** What only **commerce-core** needs. Its database is not user-service's and never reachable from it. */
export class CoreEnvironmentVariables extends EnvironmentVariables {
  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  // The production image sets this because it ships migrations/ without the src/ tree. Read by the
  // migrate CLI outside Nest, declared here so a blank value fails the boot.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  MIGRATIONS_DIR?: string;
}

/**
 * What only the **issuer** needs. commerce-core verifies tokens with the public key and mints no
 * bucketed ids, so requiring any of these there would be a deployment asking for a secret it must
 * not hold.
 */
export class UserEnvironmentVariables extends EnvironmentVariables {
  // Separate from DATABASE_URL so both apps can share one process in the e2e harness without one
  // app's connection string standing in for the other's.
  @IsString()
  @IsNotEmpty()
  USER_DATABASE_URL!: string;

  // The user journal's twin of MIGRATIONS_DIR, read the same way — by the migrate CLI, outside Nest.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  USER_MIGRATIONS_DIR?: string;

  // The node-id lease. Its own database, never this app's: setting it to USER_DATABASE_URL would
  // make Phase 6 a data migration under a live fleet instead of a process change.
  @IsString()
  @IsNotEmpty()
  IDENTITY_LEASE_DATABASE_URL!: string;

  // Which pool to lease from. Validated against ID_SERVICE_POOLS at boot, because acquire seeds a
  // pool on first contact and a typo would quietly mint its own.
  @IsString()
  @IsNotEmpty()
  IDENTITY_LEASE_SERVICE!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  ID_SERVICE_POOLS?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  LEASE_MIGRATIONS_DIR?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  IDENTITY_LEASE_TTL_SECONDS?: number;

  // Lower bound, not a default: a skew under a second is indistinguishable from no guard at all on
  // hosts whose clocks disagree.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1_000)
  IDENTITY_LEASE_SKEW_MS?: number;

  // The signing half of the ES256 keypair. Never deployed to a verifier.
  @IsString()
  @IsNotEmpty()
  JWT_ES256_PRIVATE_KEY!: string;

  // HMAC key behind the routing bucket in every user-context id. PERMANENT — rotating it routes
  // every existing account to a shard that does not hold its rows, and old buckets are not
  // recomputable, so back it up with the same rank as the database. MinLength gates length, not
  // entropy: a passphrase is brute-forceable from a few self-registered (email, bucket) pairs, so
  // generate it with `openssl rand -base64 48`.
  @IsString()
  @MinLength(MIN_BUCKET_KEY_LENGTH)
  IDENTITY_BUCKET_KEY!: string;
}

type EnvClass<T> = new () => T;

function validateAgainst<T extends object>(schema: EnvClass<T>, config: Record<string, unknown>): T {
  const validated = plainToInstance(schema, config, {
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

export function validate(config: Record<string, unknown>): CoreEnvironmentVariables {
  return validateAgainst(CoreEnvironmentVariables, config);
}

export function validateUser(config: Record<string, unknown>): UserEnvironmentVariables {
  return validateAgainst(UserEnvironmentVariables, config);
}
