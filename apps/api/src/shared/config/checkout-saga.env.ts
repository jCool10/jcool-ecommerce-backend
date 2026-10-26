import { IsInt, IsISO8601, IsNotEmpty, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { IsStrictBoolean, NodeEnv, StrictInt, type EnvBase } from '@jcool/platform/config';
import { API_DB_POOL_MAX_DEFAULT, CHECKOUT_SAGA_DEFAULTS } from './checkout-saga.config';

// Bracketed IPv6 or a hostname, then a port. No scheme: the SDK dials gRPC on the bare address.
const HOST_PORT =
  /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):([1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/;
const INSTANT =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

export function CheckoutSagaEnv<TBase extends EnvBase>(Base: TBase) {
  class CheckoutSagaEnv extends Base {
    // The lower bounds are only sanity floors: the saga suites run whole checkouts in seconds.
    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(5)
    CHECKOUT_PAYMENT_DEADLINE_SEC?: number;

    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(0)
    CHECKOUT_PAY_CUTOFF_SEC?: number;

    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(10)
    CHECKOUT_HOLD_SAFETY_SEC?: number;

    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(500)
    CHECKOUT_TRY_TIMEOUT_MS?: number;

    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(1000)
    CHECKOUT_RESERVE_WAIT_MS?: number;

    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(1000)
    CHECKOUT_CANCEL_WAIT_MS?: number;

    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(1)
    CHECKOUT_RETRY_AFTER_SEC?: number;

    @IsOptional()
    @IsStrictBoolean()
    CHECKOUT_REAPER_ENABLED?: string;

    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(1000)
    CHECKOUT_REAPER_INTERVAL_MS?: number;

    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(1)
    CHECKOUT_RESERVING_ORPHAN_SEC?: number;

    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(0)
    SAGA_AUTH_GRACE_SEC?: number;

    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(1000)
    SAGA_ACTIVITY_TIMEOUT_MS?: number;

    // Each slot can hold a pg connection; the pool rule in validate() keeps the sum honest.
    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(1)
    @Max(20)
    SAGA_ACTIVITY_CONCURRENCY?: number;

    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(1)
    @Max(20)
    SAGA_LOCAL_ACTIVITY_CONCURRENCY?: number;

    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(100)
    SAGA_RETRY_BASE_MS?: number;

    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(1000)
    SAGA_RETRY_CAP_MS?: number;

    @IsOptional()
    @IsString()
    @Matches(HOST_PORT, { message: 'TEMPORAL_ADDRESS must be host:port' })
    TEMPORAL_ADDRESS?: string;

    @IsOptional()
    @IsString()
    @IsNotEmpty()
    TEMPORAL_NAMESPACE?: string;

    @IsOptional()
    @IsString()
    @IsNotEmpty()
    TEMPORAL_TASK_QUEUE?: string;

    @IsOptional()
    @IsStrictBoolean()
    TEMPORAL_WORKER_ENABLED?: string;

    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(0)
    TEMPORAL_WORKER_SHUTDOWN_GRACE_MS?: number;

    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(0)
    TEMPORAL_WORKER_SHUTDOWN_FORCE_MS?: number;

    @IsOptional()
    @IsString()
    @IsNotEmpty()
    TEMPORAL_WORKFLOW_BUNDLE_PATH?: string;

    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(1)
    SAGA_OVERDUE_GRACE_SEC?: number;

    @IsOptional()
    @IsStrictBoolean()
    CHECKOUT_INVARIANT_ENABLED?: string;

    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(1000)
    CHECKOUT_INVARIANT_INTERVAL_MS?: number;

    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(0)
    CHECKOUT_INVARIANT_SETTLE_SEC?: number;

    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(1)
    CHECKOUT_INVARIANT_WINDOW_SEC?: number;

    // One batch is one statusOf call per participant, and statusOf takes 200 ids at most.
    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(1)
    @Max(200)
    CHECKOUT_INVARIANT_BATCH_SIZE?: number;

    // A full instant with its offset: `Date` reads a bare date as UTC and a bare time as local.
    @IsOptional()
    @IsString()
    @Matches(INSTANT, { message: 'CHECKOUT_INVARIANT_NOT_BEFORE must be an ISO-8601 instant with an offset' })
    // The pattern alone lets 02-30 through, and Date rolls it into March.
    @IsISO8601({ strict: true }, { message: 'CHECKOUT_INVARIANT_NOT_BEFORE must be a real calendar date' })
    CHECKOUT_INVARIANT_NOT_BEFORE?: string;
  }
  return CheckoutSagaEnv;
}

// Defaults owned by other config namespaces; configuration.spec pins them to what actually loads.
export const CROSS_RULE_FOREIGN_DEFAULTS = {
  PAYMENT_CAPTURE_TIMEOUT_MS: 10_000,
  BREAKER_TIMEOUT_MS: 3000,
  INVENTORY_TRY_LOCK_TIMEOUT_MS: 2000,
  QUEUE_WORKER_CONCURRENCY: 5,
  PAYMENT_SESSION_MIN_TTL_SEC: 1800,
  PAYMENT_SESSION_EXPIRY_MARGIN_SEC: 120,
  DB_POOL_MAX: API_DB_POOL_MAX_DEFAULT,
} as const;

const DEFAULTS = { ...CHECKOUT_SAGA_DEFAULTS, ...CROSS_RULE_FOREIGN_DEFAULTS };
type NumericKey = keyof typeof DEFAULTS;

// HTTP and the schedulers keep this many connections no worker can take.
const POOL_SPARE = 5;
// Production only: the buyer's minute to act on a session that opened right at the cutoff.
const PRODUCTION_CUTOFF_MARGIN_SEC = 60;

type CrossRuleEnv = Partial<Record<NumericKey, number>> & {
  NODE_ENV?: string;
  TEMPORAL_ADDRESS?: string;
  TEMPORAL_NAMESPACE?: string;
  TEMPORAL_TASK_QUEUE?: string;
};

/** Rules no single field can express; every violation is reported, each naming both sides. */
export function assertCheckoutSagaEnv(env: CrossRuleEnv): void {
  const v = (key: NumericKey): number => env[key] ?? DEFAULTS[key];
  const shown = (key: NumericKey) => `${key} (${v(key)})`;
  const violations: string[] = [];
  const require = (ok: boolean, message: string) => {
    if (!ok) violations.push(message);
  };

  if (env.NODE_ENV === NodeEnv.Production) {
    for (const key of ['TEMPORAL_ADDRESS', 'TEMPORAL_NAMESPACE', 'TEMPORAL_TASK_QUEUE'] as const) {
      require(env[key] !== undefined, `${key}: required in production`);
    }
  }

  // The slowest activity, a payment cancel, chains four gateway calls of up to T each: expire,
  // retrieve, void and the void's read-back. Temporal does not stop an attempt it timed out.
  require(v('SAGA_ACTIVITY_TIMEOUT_MS') >
    4 * v('PAYMENT_CAPTURE_TIMEOUT_MS') +
      5000, `${shown('SAGA_ACTIVITY_TIMEOUT_MS')} must exceed 4 × ${shown('PAYMENT_CAPTURE_TIMEOUT_MS')} + 5000`);
  require(v('SAGA_ACTIVITY_TIMEOUT_MS') >
    Math.max(
      v('BREAKER_TIMEOUT_MS'),
      2 * v('PAYMENT_CAPTURE_TIMEOUT_MS') + 1000,
    ), `${shown('SAGA_ACTIVITY_TIMEOUT_MS')} must exceed max(${shown('BREAKER_TIMEOUT_MS')}, 2 × ${shown('PAYMENT_CAPTURE_TIMEOUT_MS')} + 1000)`);
  require(v('INVENTORY_TRY_LOCK_TIMEOUT_MS') <
    v(
      'CHECKOUT_TRY_TIMEOUT_MS',
    ), `${shown('INVENTORY_TRY_LOCK_TIMEOUT_MS')} must be below ${shown('CHECKOUT_TRY_TIMEOUT_MS')}`);
  require(v('CHECKOUT_RESERVE_WAIT_MS') >=
    v('CHECKOUT_TRY_TIMEOUT_MS') +
      2000, `${shown('CHECKOUT_RESERVE_WAIT_MS')} must be at least ${shown('CHECKOUT_TRY_TIMEOUT_MS')} + 2000`);
  require(v('CHECKOUT_RESERVING_ORPHAN_SEC') * 1000 >
    v(
      'CHECKOUT_RESERVE_WAIT_MS',
    ), `${shown('CHECKOUT_RESERVING_ORPHAN_SEC')} × 1000 must exceed ${shown('CHECKOUT_RESERVE_WAIT_MS')}`);
  require(v('SAGA_AUTH_GRACE_SEC') <
    v(
      'CHECKOUT_HOLD_SAFETY_SEC',
    ), `${shown('SAGA_AUTH_GRACE_SEC')} must be below ${shown('CHECKOUT_HOLD_SAFETY_SEC')}`);
  require(v('SAGA_AUTH_GRACE_SEC') <
    v('SAGA_OVERDUE_GRACE_SEC'), `${shown('SAGA_AUTH_GRACE_SEC')} must be below ${shown('SAGA_OVERDUE_GRACE_SEC')}`);
  require(v('CHECKOUT_INVARIANT_WINDOW_SEC') >
    v(
      'CHECKOUT_INVARIANT_SETTLE_SEC',
    ), `${shown('CHECKOUT_INVARIANT_WINDOW_SEC')} must exceed ${shown('CHECKOUT_INVARIANT_SETTLE_SEC')}`);
  require(v('QUEUE_WORKER_CONCURRENCY') +
    v('SAGA_ACTIVITY_CONCURRENCY') +
    v('SAGA_LOCAL_ACTIVITY_CONCURRENCY') +
    POOL_SPARE <=
    v(
      'DB_POOL_MAX',
    ), `${shown('QUEUE_WORKER_CONCURRENCY')} + ${shown('SAGA_ACTIVITY_CONCURRENCY')} + ${shown('SAGA_LOCAL_ACTIVITY_CONCURRENCY')} + ${POOL_SPARE} must not exceed ${shown('DB_POOL_MAX')}`);
  require(v('SAGA_RETRY_CAP_MS') >=
    v('SAGA_RETRY_BASE_MS'), `${shown('SAGA_RETRY_CAP_MS')} must be at least ${shown('SAGA_RETRY_BASE_MS')}`);
  require(v('CHECKOUT_PAYMENT_DEADLINE_SEC') >
    v(
      'CHECKOUT_PAY_CUTOFF_SEC',
    ), `${shown('CHECKOUT_PAYMENT_DEADLINE_SEC')} must exceed ${shown('CHECKOUT_PAY_CUTOFF_SEC')}`);
  const margin = env.NODE_ENV === NodeEnv.Production ? PRODUCTION_CUTOFF_MARGIN_SEC : 0;
  require(v('CHECKOUT_PAY_CUTOFF_SEC') >=
    v('PAYMENT_SESSION_MIN_TTL_SEC') +
      v('PAYMENT_SESSION_EXPIRY_MARGIN_SEC') +
      margin, `${shown('CHECKOUT_PAY_CUTOFF_SEC')} must be at least ${shown('PAYMENT_SESSION_MIN_TTL_SEC')} + ${shown('PAYMENT_SESSION_EXPIRY_MARGIN_SEC')}${margin ? ` + ${margin}` : ''}`);

  if (violations.length > 0) {
    throw new Error(`Environment validation failed -> ${violations.join('; ')}`);
  }
}
