// Env is already validated (env.validation.ts); the defaults for omitted vars live here.
import {
  appConfig,
  databaseConfig,
  observabilityConfig,
  parseIntOr,
  redisConfig,
  resilienceConfig,
  throttleConfig,
} from '@jcool/platform/config';
import { callerTokensFromEnv } from '@jcool/platform/internal-api';

export default () => ({
  ...appConfig(),
  ...observabilityConfig({ serviceName: 'jcool-inventory-service' }),
  ...databaseConfig(),
  ...redisConfig(),
  auth: {
    jwksUrl: process.env.AUTH_JWKS_URL,
    issuer: process.env.JWT_ISSUER,
    audience: process.env.JWT_AUDIENCE,
  },
  // The keys @jcool/auth-verifier/session-state reads.
  userService: {
    url: process.env.USER_SERVICE_URL,
    token: process.env.USER_SERVICE_TOKEN,
    // Sits on the request path whenever an epoch misses Redis.
    timeoutMs: parseIntOr(process.env.USER_SERVICE_TIMEOUT_MS, 500),
  },
  idService: {
    url: process.env.ID_SERVICE_URL,
    // Covers the gateway's retries across replicas, not one attempt.
    timeoutMs: parseIntOr(process.env.ID_SERVICE_TIMEOUT_MS, 2_000),
  },
  internalApi: {
    callers: callerTokensFromEnv(['api']),
  },
  catalog: {
    publicUrl: process.env.CATALOG_PUBLIC_URL,
  },
  inventory: {
    // 'pessimistic' (SELECT ... FOR UPDATE) or 'optimistic' (version CAS + retry).
    lockStrategy: process.env.INVENTORY_LOCK_STRATEGY ?? 'pessimistic',
    // Re-CAS attempts after losing a version race before answering CONTENDED (0 = never retry).
    // Real shortfalls never consume a retry.
    optimisticMaxRetries: parseIntOr(process.env.INVENTORY_OPTIMISTIC_MAX_RETRIES, 3),
    // Budget of a whole Try, counted from the moment it is entered: id minting, the pool wait and every
    // lock wait spend it. Commit/release/restock and the lapsed-hold sweep reuse it per tx. Must stay
    // below the api's CHECKOUT_TRY_TIMEOUT_MS, which nothing here can check.
    tryLockTimeoutMs: parseIntOr(process.env.INVENTORY_TRY_LOCK_TIMEOUT_MS, 2_000),
    holdSweep: {
      enabled: process.env.INVENTORY_HOLD_SWEEP_ENABLED !== 'false',
      intervalMs: parseIntOr(process.env.INVENTORY_HOLD_SWEEP_INTERVAL_MS, 60_000),
      batchSize: parseIntOr(process.env.INVENTORY_HOLD_SWEEP_BATCH_SIZE, 50),
    },
  },
  ...throttleConfig(),
  ...resilienceConfig(),
});
