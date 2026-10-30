import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { FAKE_STRIPE_PORT } from './fake-stripe';

export const DATABASES = ['api', 'users', 'inventory', 'payment', 'orders'] as const;
export type Database = (typeof DATABASES)[number];

export const PG_USER = 'jcool';
export const TOXIPROXY_PORTS = { inventory: 8666, payment: 8667, smtp: 8668 } as const;
export const ORDER_PAID_CONSUMER_ATTEMPTS = 30;

/** The timings the scenarios measure against. */
export const SAGA_TIMINGS = {
  paymentDeadlineSec: 45,
  payCutoffSec: 30,
  authGraceSec: 5,
  inventoryCommandTimeoutMs: 3000,
  paymentCommandTimeoutMs: 5000,
  activityTimeoutMs: 11_000,
  retryBaseMs: 200,
  paymentCaptureTimeoutMs: 1000,
} as const;

const JWT_ISSUER = 'https://auth.system-test.invalid';
const JWT_AUDIENCE = 'jcool-system-test';
const MAIL = { SMTP_URL: 'smtp://mailpit:1025', MAIL_FROM: 'no-reply@jcool.local' };

const secret = () => randomBytes(32).toString('hex');

/** Fresh every run, one token per (caller, target) pair as in production. */
export function stackSecrets() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    pgPassword: secret(),
    metricsToken: secret(),
    webhookSecret: `whsec_${secret()}`,
    stripeKey: `sk_test_${secret()}`,
    csrfSecret: secret(),
    jwtPrivateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    apiToUser: secret(),
    inventoryToUser: secret(),
    orderToUser: secret(),
    orderToApi: secret(),
    orderToInventory: secret(),
    orderToPayment: secret(),
  };
}
export type StackSecrets = ReturnType<typeof stackSecrets>;

export const databaseUrl = (s: StackSecrets, db: Database, host = 'postgres', port = 5432) =>
  `postgres://${PG_USER}:${s.pgPassword}@${host}:${port}/${db}`;

/**
 * NODE_ENV=production for every app service, with timings short enough for a test run that still
 * pass each service's env validation and the cross-service rules in RUNBOOK.md.
 */
export function serviceEnv(s: StackSecrets) {
  const common = {
    NODE_ENV: 'production',
    PORT: '3000',
    LOG_LEVEL: 'warn',
    REDIS_URL: 'redis://redis:6379',
    ID_SERVICE_URL: 'http://gateway:4000',
    METRICS_TOKEN: s.metricsToken,
    TRUST_PROXY: '1',
  };
  const verifier = {
    AUTH_JWKS_URL: 'http://user-service:3000/.well-known/jwks.json',
    JWT_ISSUER,
    JWT_AUDIENCE,
  };

  return {
    api: {
      ...common,
      ...verifier,
      DATABASE_URL: databaseUrl(s, 'api'),
      USER_SERVICE_INTERNAL_URL: 'http://user-service:3000',
      INTERNAL_API_TOKEN: s.apiToUser,
      INTERNAL_CALLER_TOKEN_ORDER_SERVICE: s.orderToApi,
      // Nothing uploads here; the storage client only needs to be configured to boot.
      STORAGE_ENDPOINT: 'http://storage.invalid:9000',
      STORAGE_BUCKET: 'system-test',
      STORAGE_ACCESS_KEY_ID: 'system-test',
      STORAGE_SECRET_ACCESS_KEY: secret(),
      THROTTLE_ENABLED: 'false',
    },
    'user-service': {
      ...common,
      ...MAIL,
      DATABASE_URL: databaseUrl(s, 'users'),
      JWT_ES256_PRIVATE_KEYS: `k1:${s.jwtPrivateKeyPem}`,
      JWT_ES256_ACTIVE_KID: 'k1',
      JWT_ISSUER,
      JWT_AUDIENCE,
      CSRF_SECRET: s.csrfSecret,
      INTERNAL_API_TOKEN: s.apiToUser,
      INTERNAL_CALLER_TOKEN_INVENTORY_SERVICE: s.inventoryToUser,
      INTERNAL_CALLER_TOKEN_ORDER_SERVICE: s.orderToUser,
      IDENTITY_PIN_BOOTSTRAP: 'true',
      APP_PUBLIC_URL: 'http://gateway:8080',
      THROTTLE_ENABLED: 'false',
    },
    'inventory-service': {
      ...common,
      ...verifier,
      DATABASE_URL: databaseUrl(s, 'inventory'),
      USER_SERVICE_URL: 'http://user-service:3000',
      USER_SERVICE_TOKEN: s.inventoryToUser,
      INTERNAL_CALLER_TOKEN_ORDER_SERVICE: s.orderToInventory,
      CATALOG_PUBLIC_URL: 'http://gateway:8080',
      INVENTORY_TRY_LOCK_TIMEOUT_MS: '600',
      INVENTORY_HOLD_SWEEP_INTERVAL_MS: '1000',
      // Up to ten Try transactions at once (the order-service's local activity slots), plus spare.
      DB_POOL_MAX: '20',
    },
    'payment-service': {
      ...common,
      DATABASE_URL: databaseUrl(s, 'payment'),
      INTERNAL_CALLER_TOKEN_ORDER_SERVICE: s.orderToPayment,
      PAYMENT_WEBHOOK_SECRET: s.webhookSecret,
      STRIPE_SECRET_KEY: s.stripeKey,
      STRIPE_SUCCESS_URL: 'https://shop.system-test.invalid/checkout/success',
      STRIPE_CANCEL_URL: 'https://shop.system-test.invalid/checkout/cancel',
      STRIPE_API_HOST: 'fake-stripe',
      STRIPE_API_PORT: String(FAKE_STRIPE_PORT),
      STRIPE_API_PROTOCOL: 'http',
      // The relay stamps both on payment.authorized, so they must match the order-service's ladder.
      QUEUE_CONSUMER_BACKOFF_MS: '200',
      ORDER_PAID_CONSUMER_ATTEMPTS: String(ORDER_PAID_CONSUMER_ATTEMPTS),
      PAYMENT_CAPTURE_TIMEOUT_MS: String(SAGA_TIMINGS.paymentCaptureTimeoutMs),
      PAYMENT_SESSION_MIN_TTL_SEC: '0',
      PAYMENT_SESSION_EXPIRY_MARGIN_SEC: '0',
      // Out of every scenario's way.
      ORDER_STALE_THRESHOLD_SEC: '120',
    },
    'order-service': {
      ...common,
      ...verifier,
      ...MAIL,
      SMTP_URL: `smtp://toxiproxy:${TOXIPROXY_PORTS.smtp}`,
      DATABASE_URL: databaseUrl(s, 'orders'),
      USER_SERVICE_URL: 'http://user-service:3000',
      USER_SERVICE_TOKEN: s.orderToUser,
      API_SERVICE_URL: 'http://api:3000',
      API_SERVICE_TOKEN: s.orderToApi,
      INVENTORY_SERVICE_URL: `http://toxiproxy:${TOXIPROXY_PORTS.inventory}`,
      INVENTORY_SERVICE_TOKEN: s.orderToInventory,
      PAYMENT_SERVICE_URL: `http://toxiproxy:${TOXIPROXY_PORTS.payment}`,
      PAYMENT_SERVICE_TOKEN: s.orderToPayment,
      TEMPORAL_ADDRESS: 'temporal:7233',
      TEMPORAL_NAMESPACE: 'jcool',
      TEMPORAL_TASK_QUEUE: 'checkout-saga',
      THROTTLE_ENABLED: 'false',
      CHECKOUT_PAYMENT_DEADLINE_SEC: String(SAGA_TIMINGS.paymentDeadlineSec),
      CHECKOUT_PAY_CUTOFF_SEC: String(SAGA_TIMINGS.payCutoffSec),
      CHECKOUT_HOLD_SAFETY_SEC: '30',
      SAGA_AUTH_GRACE_SEC: String(SAGA_TIMINGS.authGraceSec),
      CHECKOUT_TRY_TIMEOUT_MS: '1000',
      CHECKOUT_RESERVE_WAIT_MS: '3000',
      CHECKOUT_RESERVING_ORPHAN_SEC: '5',
      CHECKOUT_REAPER_INTERVAL_MS: '1000',
      CHECKOUT_CANCEL_WAIT_MS: '2000',
      INVENTORY_COMMAND_TIMEOUT_MS: String(SAGA_TIMINGS.inventoryCommandTimeoutMs),
      PAYMENT_COMMAND_TIMEOUT_MS: String(SAGA_TIMINGS.paymentCommandTimeoutMs),
      SAGA_ACTIVITY_TIMEOUT_MS: String(SAGA_TIMINGS.activityTimeoutMs),
      SAGA_RETRY_BASE_MS: String(SAGA_TIMINGS.retryBaseMs),
      SAGA_RETRY_CAP_MS: '2000',
      // 5 + 2 + 10 + 5 spare = 22 ≤ 24: twenty buyers' Try calls clear in two rounds.
      SAGA_ACTIVITY_CONCURRENCY: '2',
      SAGA_LOCAL_ACTIVITY_CONCURRENCY: '10',
      QUEUE_WORKER_CONCURRENCY: '5',
      DB_POOL_MAX: '24',
      CHECKOUT_INVARIANT_INTERVAL_MS: '1000',
      CHECKOUT_INVARIANT_SETTLE_SEC: '0',
      QUEUE_CONSUMER_BACKOFF_MS: '200',
      ORDER_PAID_CONSUMER_BACKOFF_CAP_MS: '2000',
      // 200 + 400 + 800 + 1600 + 26 × 2000 ≈ 55s of backoff alone, longer than any Temporal outage here.
      ORDER_PAID_CONSUMER_ATTEMPTS: String(ORDER_PAID_CONSUMER_ATTEMPTS),
    },
  };
}
export type AppService = keyof ReturnType<typeof serviceEnv>;
