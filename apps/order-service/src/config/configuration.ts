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
import { ORDER_DB_POOL_MAX_DEFAULT, checkoutSagaConfig } from './checkout-saga.config';

export default () => ({
  ...appConfig(),
  ...observabilityConfig({ serviceName: 'jcool-order-service' }),
  database: {
    ...databaseConfig().database,
    poolMax: parseIntOr(process.env.DB_POOL_MAX, ORDER_DB_POOL_MAX_DEFAULT),
  },
  ...redisConfig(),
  queue: {
    // Must equal every publisher's: the payment-service writes payment.authorized under it.
    prefix: process.env.QUEUE_PREFIX ?? 'bull',
    workerEnabled: process.env.QUEUE_WORKER_ENABLED !== 'false',
    // Each job holds a pg connection for its transaction, so this competes with HTTP and both saga
    // activity pools for DB_POOL_MAX; env validation keeps five spare.
    workerConcurrency: parseIntOr(process.env.QUEUE_WORKER_CONCURRENCY, 5),
    consumerAttempts: parseIntOr(process.env.QUEUE_CONSUMER_ATTEMPTS, 8),
    consumerBackoffMs: parseIntOr(process.env.QUEUE_CONSUMER_BACKOFF_MS, 1000),
    // order.paid waits on the user-service for the buyer's address: about 30 minutes at the defaults.
    orderPaidAttempts: parseIntOr(process.env.ORDER_PAID_CONSUMER_ATTEMPTS, 15),
    orderPaidBackoffCapMs: parseIntOr(process.env.ORDER_PAID_CONSUMER_BACKOFF_CAP_MS, 300_000),
  },
  outbox: {
    relayEnabled: process.env.OUTBOX_RELAY_ENABLED !== 'false',
    pollMs: parseIntOr(process.env.OUTBOX_POLL_MS, 1000),
    batchSize: parseIntOr(process.env.OUTBOX_BATCH_SIZE, 100),
  },
  auth: {
    jwksUrl: process.env.AUTH_JWKS_URL,
    issuer: process.env.JWT_ISSUER,
    audience: process.env.JWT_AUDIENCE,
  },
  // The keys @jcool/auth-verifier/session-state reads.
  userService: {
    url: process.env.USER_SERVICE_URL,
    token: process.env.USER_SERVICE_TOKEN,
    timeoutMs: parseIntOr(process.env.USER_SERVICE_TIMEOUT_MS, 500),
  },
  idService: {
    url: process.env.ID_SERVICE_URL,
    // Covers the gateway's retries across replicas, not one attempt.
    timeoutMs: parseIntOr(process.env.ID_SERVICE_TIMEOUT_MS, 2_000),
  },
  // Cart lines and SKU views, read before tx A. The api's private address, never the gateway.
  apiService: {
    url: process.env.API_SERVICE_URL,
    token: process.env.API_SERVICE_TOKEN,
    timeoutMs: parseIntOr(process.env.API_SERVICE_TIMEOUT_MS, 2_000),
  },
  inventoryService: {
    url: process.env.INVENTORY_SERVICE_URL,
    token: process.env.INVENTORY_SERVICE_TOKEN,
    // Commit, release, restock and status; a Try is bounded by checkoutSaga.tryTimeoutMs instead.
    commandTimeoutMs: parseIntOr(process.env.INVENTORY_COMMAND_TIMEOUT_MS, 5_000),
  },
  paymentService: {
    url: process.env.PAYMENT_SERVICE_URL,
    token: process.env.PAYMENT_SERVICE_TOKEN,
    // A cancel there chains up to four Stripe calls, each bounded by its PAYMENT_CAPTURE_TIMEOUT_MS.
    commandTimeoutMs: parseIntOr(process.env.PAYMENT_COMMAND_TIMEOUT_MS, 45_000),
  },
  userDirectory: {
    notFoundGrace: process.env.USER_DIRECTORY_NOT_FOUND_GRACE ?? '10m',
  },
  ...mailConfig(),
  ...throttleConfig(),
  retention: {
    ...retentionConfig().retention,
    // Past an idempotency key's own `expires_at`; only slack for clock skew.
    idempotencyGraceSec: parseIntOr(process.env.RETENTION_IDEMPOTENCY_GRACE_SEC, 3_600),
    outboxDays: parseIntOr(process.env.RETENTION_OUTBOX_DAYS, 30),
    // A correctness bound, guarded at boot against the queue's failed-job horizon.
    inboxDays: parseIntOr(process.env.RETENTION_INBOX_DAYS, 30),
    rejectedOrderDays: parseIntOr(process.env.RETENTION_REJECTED_ORDER_DAYS, 30),
  },
  ...resilienceConfig(),
  ...checkoutSagaConfig(),
});
