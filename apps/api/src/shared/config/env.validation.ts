import { IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, Max, Min, MinLength } from 'class-validator';
import { MIN_INBOX_RETENTION_DAYS } from '@jcool/messaging';
import {
  AppEnv,
  DatabaseEnv,
  EmptyEnv,
  IsStrictBoolean,
  NodeEnv,
  ObservabilityEnv,
  RedisEnv,
  ResilienceEnv,
  RetentionEnv,
  StrictInt,
  ThrottleEnv,
  validateEnv,
} from '@jcool/platform/config';

const PlatformEnv = RetentionEnv(ResilienceEnv(ObservabilityEnv(RedisEnv(DatabaseEnv(ThrottleEnv(AppEnv(EmptyEnv)))))));

const HTTP_URL = { require_tld: false, require_protocol: true, protocols: ['http', 'https'] };

// What configuration.ts loads for an unset var; configuration.spec pins the two together.
export const POOL_RULE_DEFAULTS = { QUEUE_WORKER_CONCURRENCY: 5, DB_POOL_MAX: 10 } as const;
// HTTP and the schedulers keep this many connections the api-events worker cannot take.
const POOL_SPARE = 5;

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

  // Optional, like every caller token: the guard is what refuses a boot with none.
  @IsOptional()
  @IsString()
  @MinLength(32)
  INTERNAL_CALLER_TOKEN_ORDER_SERVICE?: string;

  @IsOptional()
  @IsString()
  @MinLength(32)
  INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS?: string;

  // Catalog events wait on the search engine, so they outlast the default ladder.
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
  const concurrency = env.QUEUE_WORKER_CONCURRENCY ?? POOL_RULE_DEFAULTS.QUEUE_WORKER_CONCURRENCY;
  const poolMax = env.DB_POOL_MAX ?? POOL_RULE_DEFAULTS.DB_POOL_MAX;
  if (concurrency + POOL_SPARE > poolMax) {
    throw new Error(
      `Environment validation failed -> QUEUE_WORKER_CONCURRENCY (${concurrency}) + ${POOL_SPARE} must not exceed DB_POOL_MAX (${poolMax})`,
    );
  }
  return env;
}
