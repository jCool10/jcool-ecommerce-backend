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

/** Environment schema, validated once at startup (fail-fast) — required: NODE_ENV, DATABASE_URL, REDIS_URL, JWT_ACCESS_SECRET; optional vars fall back to defaults applied in configuration.ts. */
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

  @IsString()
  @IsNotEmpty()
  REDIS_URL!: string;

  @IsOptional()
  @IsBooleanString()
  SWAGGER_ENABLED?: string;

  // pino log level; defaults to debug in dev, info in prod (configuration.ts).
  @IsOptional()
  @IsEnum(LogLevel)
  LOG_LEVEL?: LogLevel;

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
