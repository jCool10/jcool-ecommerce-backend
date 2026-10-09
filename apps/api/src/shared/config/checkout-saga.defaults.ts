/**
 * The defaults configuration.ts applies, shared with the cross-field checks in env.validation.ts so
 * an unset variable is checked as the value it will actually load as.
 */
export const CHECKOUT_SAGA_DEFAULTS = {
  CHECKOUT_PAYMENT_DEADLINE_SEC: 3_600,
  CHECKOUT_PAY_CUTOFF_SEC: 1_980,
  CHECKOUT_TRY_TIMEOUT_MS: 3_000,
  CHECKOUT_HOLD_SAFETY_SEC: 3_600,
  SAGA_RUNNER_INTERVAL_MS: 1_000,
  SAGA_RUNNER_BATCH_SIZE: 20,
  SAGA_LEASE_MS: 60_000,
  SAGA_RETRY_BASE_MS: 1_000,
  SAGA_RETRY_CAP_MS: 300_000,
  SAGA_KICK_CONCURRENCY: 2,
  SAGA_AUTH_GRACE_SEC: 180,
  RETENTION_REJECTED_ORDER_DAYS: 30,
  PAYMENT_SESSION_MIN_TTL_SEC: 1_800,
  PAYMENT_SESSION_EXPIRY_MARGIN_SEC: 120,
  PAYMENT_CAPTURE_TIMEOUT_MS: 10_000,
  INVENTORY_TRY_LOCK_TIMEOUT_MS: 2_000,
  QUEUE_WORKER_CONCURRENCY: 5,
  // Applied by the platform's databaseConfig; repeated here only for the pool check.
  DB_POOL_MAX: 10,
} as const;
