import { parseIntOr } from '@jcool/platform/config';

// Keyed by env var so env validation resolves an unset var to the same value this config loads.
export const CHECKOUT_SAGA_DEFAULTS = {
  CHECKOUT_PAYMENT_DEADLINE_SEC: 3600,
  CHECKOUT_PAY_CUTOFF_SEC: 1980,
  CHECKOUT_HOLD_SAFETY_SEC: 3600,
  CHECKOUT_TRY_TIMEOUT_MS: 3000,
  CHECKOUT_RESERVE_WAIT_MS: 6000,
  CHECKOUT_CANCEL_WAIT_MS: 10_000,
  CHECKOUT_RETRY_AFTER_SEC: 5,
  CHECKOUT_REAPER_INTERVAL_MS: 60_000,
  CHECKOUT_RESERVING_ORPHAN_SEC: 60,
  SAGA_AUTH_GRACE_SEC: 180,
  SAGA_ACTIVITY_TIMEOUT_MS: 60_000,
  SAGA_ACTIVITY_CONCURRENCY: 2,
  SAGA_LOCAL_ACTIVITY_CONCURRENCY: 2,
  SAGA_RETRY_BASE_MS: 1000,
  SAGA_RETRY_CAP_MS: 300_000,
  TEMPORAL_WORKER_SHUTDOWN_GRACE_MS: 4000,
  TEMPORAL_WORKER_SHUTDOWN_FORCE_MS: 4000,
} as const;

// Above the platform's 10: the saga worker's two activity pools draw on the same pool as HTTP and the
// queue worker (5 + 2 + 2 + 5 spare = 14).
export const API_DB_POOL_MAX_DEFAULT = 20;

const int = (key: keyof typeof CHECKOUT_SAGA_DEFAULTS): number =>
  parseIntOr(process.env[key], CHECKOUT_SAGA_DEFAULTS[key]);

export const checkoutSagaConfig = () => ({
  checkoutSaga: {
    // From placedAt. A payment session opens only while at least payCutoffSec of it remains.
    paymentDeadlineSec: int('CHECKOUT_PAYMENT_DEADLINE_SEC'),
    payCutoffSec: int('CHECKOUT_PAY_CUTOFF_SEC'),
    // hold_until = deadline + this, so the lapsed-hold sweep never races a saga still waiting.
    holdSafetySec: int('CHECKOUT_HOLD_SAFETY_SEC'),
    tryTimeoutMs: int('CHECKOUT_TRY_TIMEOUT_MS'),
    reserveWaitMs: int('CHECKOUT_RESERVE_WAIT_MS'),
    cancelWaitMs: int('CHECKOUT_CANCEL_WAIT_MS'),
    // Retry-After on a checkout or cancel that got no answer in its wait.
    retryAfterSec: int('CHECKOUT_RETRY_AFTER_SEC'),
    reaper: {
      enabled: process.env.CHECKOUT_REAPER_ENABLED !== 'false',
      intervalMs: int('CHECKOUT_REAPER_INTERVAL_MS'),
    },
    reservingOrphanSec: int('CHECKOUT_RESERVING_ORPHAN_SEC'),
    // An authorization that lands this long after the deadline still completes the order.
    authGraceSec: int('SAGA_AUTH_GRACE_SEC'),
    activityTimeoutMs: int('SAGA_ACTIVITY_TIMEOUT_MS'),
    activityConcurrency: int('SAGA_ACTIVITY_CONCURRENCY'),
    localActivityConcurrency: int('SAGA_LOCAL_ACTIVITY_CONCURRENCY'),
    retryBaseMs: int('SAGA_RETRY_BASE_MS'),
    retryCapMs: int('SAGA_RETRY_CAP_MS'),
    temporal: {
      address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
      namespace: process.env.TEMPORAL_NAMESPACE ?? 'jcool',
      taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'checkout-saga',
      workerEnabled: process.env.TEMPORAL_WORKER_ENABLED !== 'false',
      workerShutdownGraceMs: int('TEMPORAL_WORKER_SHUTDOWN_GRACE_MS'),
      workerShutdownForceMs: int('TEMPORAL_WORKER_SHUTDOWN_FORCE_MS'),
      // Unset: the bundle built into dist in production, the TS sources otherwise.
      workflowBundlePath: process.env.TEMPORAL_WORKFLOW_BUNDLE_PATH,
    },
  },
});

export type CheckoutSagaConfig = ReturnType<typeof checkoutSagaConfig>['checkoutSaga'];
