import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, Max, Min, MinLength } from 'class-validator';
import { MIN_INBOX_RETENTION_DAYS } from '@shared/messaging/queue/queue.constants';
import {
  AppEnv,
  DatabaseEnv,
  EmptyEnv,
  IsStrictBoolean,
  MailEnv,
  NodeEnv,
  ObservabilityEnv,
  RedisEnv,
  ResilienceEnv,
  RetentionEnv,
  StrictInt,
  ThrottleEnv,
  validateEnv,
} from '@jcool/platform/config';
import { CHECKOUT_SAGA_DEFAULTS } from './checkout-saga.defaults';

export enum InventoryLockStrategy {
  Pessimistic = 'pessimistic',
  Optimistic = 'optimistic',
}

// One member today: the enum earns its place by rejecting any other value at startup instead of
// letting a typo pick a gateway that does not exist.
export enum PaymentProvider {
  Stripe = 'stripe',
}

const PlatformEnv = RetentionEnv(
  MailEnv(ResilienceEnv(ObservabilityEnv(RedisEnv(DatabaseEnv(ThrottleEnv(AppEnv(EmptyEnv))))))),
);

const HTTP_URL = { require_tld: false, require_protocol: true, protocols: ['http', 'https'] };

/** Validated once at startup, so a bad value fails the boot. Every optional var falls back to a
 * default applied in configuration.ts; the comments here only explain the BOUNDS. */
export class EnvironmentVariables extends PlatformEnv {
  // @IsNotEmpty because a blank prefix would silently produce a different, colliding key layout
  // rather than falling back to the default.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  QUEUE_PREFIX?: string;

  @IsOptional()
  @IsStrictBoolean()
  QUEUE_WORKER_ENABLED?: string;

  // The cap is a sanity bound, NOT a guarantee against the pool: each in-flight job holds a
  // connection for its transaction, so this and DB_POOL_MAX have to be sized against each other.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  @Max(50)
  QUEUE_WORKER_CONCURRENCY?: number;

  // Capped at 10 rather than left open because the backoff doubles: ten tries already stretch the
  // last wait past eight minutes, and a message nobody can apply belongs in the DLQ long before that.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  @Max(10)
  QUEUE_CONSUMER_ATTEMPTS?: number;

  // Min 100 so a typo cannot turn the retry budget into a tight loop against whatever dependency is
  // already failing.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  @Max(60_000)
  QUEUE_CONSUMER_BACKOFF_MS?: number;

  @IsOptional()
  @IsStrictBoolean()
  OUTBOX_RELAY_ENABLED?: string;

  // Min 100 so a typo cannot turn the relay into a busy loop opening transactions against the
  // outbox table.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  OUTBOX_POLL_MS?: number;

  // Capped because the publish happens inside the polling transaction, so the batch size is also
  // how long row locks are held.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  @Max(1000)
  OUTBOX_BATCH_SIZE?: number;

  @IsOptional()
  @IsStrictBoolean()
  RECONCILE_ENABLED?: string;

  // Min 1000 so a typo can't turn the sweep into a busy loop hammering the payment gateway.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1000)
  RECONCILE_INTERVAL_MS?: number;

  // Capped so one tick can't fan out an unbounded number of gateway round-trips.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  @Max(500)
  RECONCILE_BATCH_SIZE?: number;

  // 0 is legal — e2e drives the sweep deterministically.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(0)
  ORDER_STALE_THRESHOLD_SEC?: number;

  // Lower bounds only refuse nonsense: the fault suite runs a checkout end to end in under a minute.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  CHECKOUT_PAYMENT_DEADLINE_SEC?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(0)
  CHECKOUT_PAY_CUTOFF_SEC?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  @Max(60_000)
  CHECKOUT_TRY_TIMEOUT_MS?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  CHECKOUT_HOLD_SAFETY_SEC?: number;

  @IsOptional()
  @IsStrictBoolean()
  SAGA_RUNNER_ENABLED?: string;

  // Below the 1000 floor the other sweeps use: the fault suite ticks every 500ms.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  @Max(3_600_000)
  SAGA_RUNNER_INTERVAL_MS?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  @Max(500)
  SAGA_RUNNER_BATCH_SIZE?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1000)
  @Max(3_600_000)
  SAGA_LEASE_MS?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  SAGA_RETRY_BASE_MS?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  @Max(3_600_000)
  SAGA_RETRY_CAP_MS?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  @Max(50)
  SAGA_KICK_CONCURRENCY?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(0)
  SAGA_AUTH_GRACE_SEC?: number;

  // 0 is legal: the key's own TTL is already the retry window, so this is only slack for clock skew.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(0)
  RETENTION_IDEMPOTENCY_GRACE_SEC?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  RETENTION_OUTBOX_DAYS?: number;

  // A correctness bound: while the queue can still redeliver a message, its claim is the only thing
  // stopping the effect being applied twice. The floor is DERIVED from the queue's failed-job
  // horizon so the pair cannot drift.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(MIN_INBOX_RETENTION_DAYS)
  RETENTION_INBOX_DAYS?: number;

  // The floor tracks the GATEWAY's redelivery window (Stripe retries for ~72h), not the queue's.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(14)
  RETENTION_WEBHOOK_EVENT_DAYS?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  RETENTION_REJECTED_ORDER_DAYS?: number;

  // Min 1 — a 0 would make every entry stale the instant it is written, turning every read into a
  // stale serve plus a background rebuild.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  CATALOG_CACHE_TTL_SEC?: number;

  // The stale window and the jitter below accept 0, which switches off stale-serving (resp. jitter);
  // switching off SWR takes both, since jitter also outlives freshness.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  CACHE_SOFT_TTL_SEC?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(0)
  CACHE_STALE_WINDOW_SEC?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(0)
  CACHE_TTL_JITTER_SEC?: number;

  // Min 100 because a lease shorter than a rebuild admits a second holder on every refill, which is
  // the stampede this lock exists to stop.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  CACHE_LOCK_LEASE_MS?: number;

  // 0 is legal — it opts out of waiting and reads through to Postgres immediately.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(0)
  CACHE_LOCK_WAIT_MS?: number;

  @IsOptional()
  @IsStrictBoolean()
  SEARCH_ENABLED?: string;

  // @IsNotEmpty so a blank value fails at boot instead of silently falling back to the local default.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  SEARCH_URL?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  SEARCH_USERNAME?: string;

  // Optional because a local engine may run with security off.
  @IsOptional()
  @IsString()
  @MinLength(16)
  SEARCH_PASSWORD?: string;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  SEARCH_REQUEST_TIMEOUT_MS?: number;

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
  @StrictInt()
  @IsInt()
  @Min(60)
  @Max(3600)
  STORAGE_PRESIGN_TTL_SEC?: number;

  // Min 300 keeps a slow upload from being swept out from under itself.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(300)
  MEDIA_UPLOAD_TTL_SEC?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(300)
  MEDIA_READY_TTL_SEC?: number;

  // Min 1024 rejects a value that would refuse every real image.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1024)
  MEDIA_MAX_BYTES?: number;

  @IsOptional()
  @IsEnum(InventoryLockStrategy)
  INVENTORY_LOCK_STRATEGY?: InventoryLockStrategy;

  // Capped so a misconfig can't spin the CAS loop while it pins the stock row's write-lock.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(0)
  @Max(10)
  INVENTORY_OPTIMISTIC_MAX_RETRIES?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  @Max(30_000)
  INVENTORY_TRY_LOCK_TIMEOUT_MS?: number;

  @IsOptional()
  @IsStrictBoolean()
  INVENTORY_HOLD_SWEEP_ENABLED?: string;

  // Node runs a delay past 2^31-1 ms every 1 ms.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1000)
  @Max(3_600_000)
  INVENTORY_HOLD_SWEEP_INTERVAL_MS?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  @Max(500)
  INVENTORY_HOLD_SWEEP_BATCH_SIZE?: number;

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
  @StrictInt()
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

  // 0 is legal for both: a stack in front of a fake Stripe has no minimum to respect.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(0)
  PAYMENT_SESSION_MIN_TTL_SEC?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(0)
  PAYMENT_SESSION_EXPIRY_MARGIN_SEC?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  @Max(60_000)
  PAYMENT_CAPTURE_TIMEOUT_MS?: number;

  // The only way in: without it every token is refused, so it is required rather than optional.
  @IsUrl(HTTP_URL)
  AUTH_JWKS_URL!: string;

  @IsString()
  @IsNotEmpty()
  JWT_ISSUER!: string;

  @IsString()
  @IsNotEmpty()
  JWT_AUDIENCE!: string;

  @IsUrl(HTTP_URL)
  USER_SERVICE_INTERNAL_URL!: string;

  @IsString()
  @MinLength(32)
  INTERNAL_API_TOKEN!: string;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  USER_SERVICE_TIMEOUT_MS?: number;

  // The gateway's internal load balancer, never a single replica. Every write mints its ids here.
  @IsUrl(HTTP_URL)
  ID_SERVICE_URL!: string;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  ID_SERVICE_TIMEOUT_MS?: number;

  // Duration form. How long after an order is paid a user the directory does not know is still
  // worth waiting for.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  USER_DIRECTORY_NOT_FOUND_GRACE?: string;

  // order.paid (user-service) and catalog events (search engine) wait on another service, so they outlast
  // the default ladder.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  @Max(30)
  ORDER_PAID_CONSUMER_ATTEMPTS?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  ORDER_PAID_CONSUMER_BACKOFF_CAP_MS?: number;
}

export function validate(config: Record<string, unknown>): EnvironmentVariables {
  const env = validateEnv(EnvironmentVariables, config);
  // Unset behind the gateway, every IP-keyed throttle tier keys on the proxy's address instead of
  // the client's. "false" stays a valid, deliberate answer for a deploy nothing proxies.
  if (env.NODE_ENV === NodeEnv.Production && env.TRUST_PROXY === undefined) {
    throw new Error(
      'Environment validation failed -> TRUST_PROXY: required in production; set the proxies to trust (subnets or a hop count), or "false" when nothing proxies',
    );
  }
  // Without a key the adapter falls back to fabricated sessions that can never settle, so every
  // order would quietly expire. PAYMENT_PROVIDER is not consulted: nothing sets it on Railway.
  if (env.NODE_ENV === NodeEnv.Production && (!env.STRIPE_SECRET_KEY || !env.STRIPE_SUCCESS_URL)) {
    throw new Error('Environment validation failed -> STRIPE_SECRET_KEY/STRIPE_SUCCESS_URL: required in production');
  }
  assertCheckoutSagaTimings(env);
  return env;
}

function assertCheckoutSagaTimings(env: EnvironmentVariables): void {
  const value = (key: keyof typeof CHECKOUT_SAGA_DEFAULTS): number =>
    (env[key as keyof EnvironmentVariables] as number | undefined) ?? CHECKOUT_SAGA_DEFAULTS[key];
  const refuse = (keys: string, rule: string): never => {
    throw new Error(`Environment validation failed -> ${keys}: ${rule}`);
  };

  const leaseMs = value('SAGA_LEASE_MS');
  const captureMs = value('PAYMENT_CAPTURE_TIMEOUT_MS');
  const tryMs = value('CHECKOUT_TRY_TIMEOUT_MS');
  // Two advances holding one saga would both capture. A payment cancel is the slowest call a lease
  // covers: up to four gateway requests of PAYMENT_CAPTURE_TIMEOUT_MS each.
  if (leaseMs <= 4 * captureMs + 5_000) {
    refuse('SAGA_LEASE_MS', `must exceed 4 × PAYMENT_CAPTURE_TIMEOUT_MS + 5000 (${4 * captureMs + 5_000})`);
  }
  if (leaseMs <= tryMs + 5_000) {
    refuse('SAGA_LEASE_MS', `must exceed CHECKOUT_TRY_TIMEOUT_MS + 5000 (${tryMs + 5_000})`);
  }
  // A Try still running after the checkout gave up on it would hold a connection past the answer.
  if (value('INVENTORY_TRY_LOCK_TIMEOUT_MS') >= tryMs) {
    refuse('INVENTORY_TRY_LOCK_TIMEOUT_MS', 'must stay below CHECKOUT_TRY_TIMEOUT_MS');
  }
  if (value('SAGA_AUTH_GRACE_SEC') >= value('CHECKOUT_HOLD_SAFETY_SEC')) {
    refuse('SAGA_AUTH_GRACE_SEC', 'must stay below CHECKOUT_HOLD_SAFETY_SEC, so the hold outlives the grace');
  }
  if (value('QUEUE_WORKER_CONCURRENCY') + value('SAGA_KICK_CONCURRENCY') >= value('DB_POOL_MAX')) {
    refuse('QUEUE_WORKER_CONCURRENCY/SAGA_KICK_CONCURRENCY', 'together must stay below DB_POOL_MAX');
  }
  const sessionFloorSec = value('PAYMENT_SESSION_MIN_TTL_SEC') + value('PAYMENT_SESSION_EXPIRY_MARGIN_SEC');
  if (value('CHECKOUT_PAY_CUTOFF_SEC') < sessionFloorSec + 30) {
    refuse(
      'CHECKOUT_PAY_CUTOFF_SEC',
      `must be at least PAYMENT_SESSION_MIN_TTL_SEC + PAYMENT_SESSION_EXPIRY_MARGIN_SEC + 30 (${sessionFloorSec + 30})`,
    );
  }
  if (value('CHECKOUT_PAYMENT_DEADLINE_SEC') <= value('CHECKOUT_PAY_CUTOFF_SEC')) {
    refuse('CHECKOUT_PAYMENT_DEADLINE_SEC', 'must exceed CHECKOUT_PAY_CUTOFF_SEC');
  }
}
